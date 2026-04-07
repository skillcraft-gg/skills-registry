#!/usr/bin/env node
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || ''
const EVENT_PATH = process.env.GITHUB_EVENT_PATH
const ZERO_SHA = '0000000000000000000000000000000000000000'
const PAGES_BASE_URL = process.env.SKILLCRAFT_PAGES_BASE_URL || 'https://skillcraft.gg'
const SEARCH_INDEX_PATH = 'search/index.json'
const USER_AGENT = 'skillcraft-search-index'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_EXTERNAL_REGISTRIES_PATH = path.join(SCRIPT_DIR, '..', '..', 'external')

export async function runSearchIndexWorkflow() {
  const eventMetadata = await loadEventMetadata()
  const existingIndex = EVENT_NAME === 'push' ? await loadExistingIndex() : []

  if (EVENT_NAME === 'push') {
    const { before, after, repository, ref } = eventMetadata
    if (!repository?.full_name) {
      throw new Error('Could not read repository metadata from event payload')
    }

    if (!isMainRef(ref, repository.default_branch)) {
      process.stdout.write('Skipping index build outside main branch context\n')
      return
    }

    const changedSkillIds = await getChangedSkillIds(before, after)

    if (!changedSkillIds) {
      await rebuildAndWriteIndex()
      process.stdout.write('Built search index from full scan due unavailable diff.\n')
      return
    }

    if (changedSkillIds.size === 0) {
      await rebuildAndWriteIndex()
      process.stdout.write('Built search index from full scan due no detectable skill changes.\n')
      return
    }

    const nextIndex = updateIndexForSkills(existingIndex, changedSkillIds)
    const changed = await writeIndex(nextIndex)
    if (!changed) {
      process.stdout.write('No search index changes.\n')
      return
    }

    process.stdout.write(`Updated search index for ${changedSkillIds.size} skill path(s).\n`)
    return
  }

  if (EVENT_NAME === 'workflow_dispatch') {
    await rebuildAndWriteIndex()
    process.stdout.write('Rebuilt search index from full scan.\n')
    return
  }

  process.stdout.write(`Unsupported event ${EVENT_NAME}; skipping index build\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runSearchIndexWorkflow()
}

async function updateIndexForSkills(index, changedIds) {
  const map = new Map(index.map((entry) => [entry.id, entry]))

  for (const id of changedIds) {
    const manifestPath = manifestPathForId(id)

    if (!(await fileExists(manifestPath))) {
      map.delete(id)
      continue
    }

    const raw = await fs.readFile(manifestPath, 'utf8')
    const record = parseRecord(raw, id)

    if (record.id !== id) {
      throw new Error(`Manifest id mismatch for ${manifestPath}: ${record.id} !== ${id}`)
    }

    const [owner, slug] = id.split('/')
    map.set(id, {
      id,
      name: record.name,
      path: `${path.posix.join('skills', owner, slug, '')}`,
      url: `${PAGES_BASE_URL}/${path.posix.join('skills', owner, slug, '')}`,
      owner,
      slug,
      runtime: normalizeStringArray(record.runtime, 'runtime'),
      tags: normalizeStringArray(record.tags, 'tags'),
      updatedAt: await fileUpdatedAt(manifestPath),
    })
  }

  return Array.from(map.values()).sort((left, right) => left.id.localeCompare(right.id))
}

function parseRecord(input, expectedId) {
  const parsed = parseYaml(input)
  if (!isObject(parsed)) {
    throw new Error(`Manifest does not contain a YAML object at ${manifestPathForId(expectedId)}`)
  }

  const id = String(parsed.id || '').trim()
  const name = String(parsed.name || '').trim()

  if (!id) {
    throw new Error(`Manifest missing required id at ${manifestPathForId(expectedId)}`)
  }

  if (!name) {
    throw new Error(`Manifest missing required name at ${manifestPathForId(expectedId)}`)
  }

  if (!isValidIdentifier(id)) {
    throw new Error(`Manifest id invalid at ${manifestPathForId(expectedId)}: ${id}`)
  }

  const [owner, slug] = id.split('/')
  if (!owner || !slug) {
    throw new Error(`Manifest id malformed at ${manifestPathForId(expectedId)}: ${id}`)
  }

  if (expectedId && id !== expectedId) {
    throw new Error(`Manifest id ${id} does not match path ${expectedId}`)
  }

  return {
    id,
    name,
    runtime: parsed.runtime,
    tags: parsed.tags,
  }
}

async function rebuildAndWriteIndex() {
  const rebuilt = []
  const owners = await readDirectoryEntries('skills')

  for (const owner of owners) {
    const ownerDir = path.join('skills', owner)
    const ownerEntries = await readDirectoryEntries(ownerDir)

    for (const slug of ownerEntries) {
      const id = `${owner}/${slug}`
      const manifestPath = manifestPathForId(id)

      if (!(await fileExists(manifestPath))) {
        continue
      }

      const raw = await fs.readFile(manifestPath, 'utf8')
      const record = parseRecord(raw, id)

      if (record.id !== id) {
        throw new Error(`Manifest id mismatch for ${manifestPath}: ${record.id} !== ${id}`)
      }

      rebuilt.push({
        id: record.id,
        name: record.name,
        path: `${path.posix.join('skills', owner, slug, '')}`,
        url: `${PAGES_BASE_URL}/${path.posix.join('skills', owner, slug, '')}`,
        owner,
        slug,
        runtime: normalizeStringArray(record.runtime, 'runtime'),
        tags: normalizeStringArray(record.tags, 'tags'),
        updatedAt: await fileUpdatedAt(manifestPath),
      })
    }
  }

  const externalEntries = await loadExternalRegistryEntries()
  rebuilt.push(...externalEntries)

  rebuilt.sort((left, right) => left.id.localeCompare(right.id))
  await writeIndex(rebuilt)
}

async function loadExternalRegistryEntries() {
  const externalRegistries = await loadExternalRegistryConfigs()
  const entries = []

  for (const source of externalRegistries) {
    const remote = await loadExternalRegistry(source)
    for (const entry of remote) {
      entries.push(entry)
    }
  }

  return entries
}

async function loadExternalRegistryConfigs() {
  const explicitPath = process.env.SKILLCRAFT_EXTERNAL_REGISTRIES_PATH?.trim()
  const configPath = explicitPath || DEFAULT_EXTERNAL_REGISTRIES_PATH
  const absolutePath = path.resolve(configPath)
  const stat = await fs.stat(absolutePath)

  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true })
    const registryFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((left, right) => {
      return left.name.localeCompare(right.name)
    })

    const registries = []
    for (const registryFile of registryFiles) {
      const registryPath = path.join(absolutePath, registryFile.name)
      const parsed = await loadExternalRegistryConfig(registryPath)
      registries.push(parsed)
    }

    return registries
  }

  if (!stat.isFile()) {
    throw new Error(`External registries path is neither a file nor directory: ${absolutePath}`)
  }

  return [await loadExternalRegistryConfig(absolutePath)]
}

async function loadExternalRegistryConfig(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  return normalizeExternalRegistry(parsed, filePath)
}

function normalizeExternalRegistry(value, filePath) {
  if (!isObject(value)) {
    throw new Error(`External registry config must be a JSON object: ${filePath}`)
  }

  const id = String(value.id || '').trim()
  const marketplaceUrl = String(value.marketplaceUrl || '').trim()
  const directoryListingUrl = String(value.directoryListingUrl || '').trim()
  const skillsDirectoryPath = String(value.skillsDirectoryPath || '').trim()
  const repositoryBaseUrl = String(value.repositoryBaseUrl || '').trim()
  const pagesBaseUrl = String(value.pagesBaseUrl || '').trim()

  if (!id || !repositoryBaseUrl || !pagesBaseUrl) {
    throw new Error(`External registry config ${filePath} is missing required fields`)
  }

  if (!marketplaceUrl && !directoryListingUrl) {
    throw new Error(`External registry config ${filePath} must include marketplaceUrl or directoryListingUrl`)
  }

  if (directoryListingUrl && !skillsDirectoryPath) {
    throw new Error(`External registry config ${filePath} must include skillsDirectoryPath when using directoryListingUrl`)
  }

  return {
    id,
    ...(marketplaceUrl ? { marketplaceUrl } : {}),
    ...(directoryListingUrl ? { directoryListingUrl } : {}),
    ...(skillsDirectoryPath ? { skillsDirectoryPath } : {}),
    repositoryBaseUrl,
    pagesBaseUrl,
  }
}

export async function loadExternalRegistry(source) {
  if (source.directoryListingUrl) {
    return loadExternalDirectoryRegistry(source)
  }

  const response = await fetch(source.marketplaceUrl, {
    headers: {
      'user-agent': USER_AGENT,
    },
  })

  if (!response.ok) {
    throw new Error(`Unable to fetch marketplace metadata for ${source.id}`)
  }

  const payload = await response.json()
  if (!payload || !Array.isArray(payload.plugins)) {
    return []
  }

  const pluginSkills = []
  const uniqueSkills = new Set()

  for (const plugin of payload.plugins) {
    if (!plugin || !Array.isArray(plugin.skills)) {
      continue
    }
    for (const rawSkillRef of plugin.skills) {
      if (typeof rawSkillRef !== 'string') {
        continue
      }
      const trimmed = rawSkillRef.trim()
      if (!trimmed) {
        continue
      }

      const mappedId = mapMarketplaceSkillToId(source.id, trimmed)
      if (!mappedId) {
        continue
      }
      if (uniqueSkills.has(mappedId.id)) {
        continue
      }

      const manifestPath = `${mappedId.relativeDir}/SKILL.md`
      const docResponse = await loadRemoteText(`${source.repositoryBaseUrl}/${manifestPath}`)
      const frontMatter = parseFrontMatter(docResponse.text)
      const title = String(frontMatter.name || '').trim()

      pluginSkills.push({
        id: mappedId.id,
        name: title || mappedId.slug,
        path: `${path.posix.join(mappedId.relativeDir, '')}`,
        url: `${source.pagesBaseUrl}/${mappedId.relativeDir}/`,
        owner: mappedId.owner,
        slug: mappedId.slug,
        runtime: normalizeStringArray(frontMatter.runtime, 'runtime'),
        tags: normalizeStringArray(frontMatter.tags, 'tags'),
        updatedAt: docResponse.lastModified || new Date().toISOString(),
      })
      uniqueSkills.add(mappedId.id)
    }
  }

  return pluginSkills
}

async function loadExternalDirectoryRegistry(source) {
  const response = await fetch(source.directoryListingUrl, {
    headers: {
      'user-agent': USER_AGENT,
    },
  })

  if (!response.ok) {
    throw new Error(`Unable to fetch directory listing for ${source.id}`)
  }

  const payload = await response.json()
  if (!Array.isArray(payload)) {
    return []
  }

  const entries = []
  const uniqueSkills = new Set()

  for (const item of payload) {
    if (!item || item.type !== 'dir' || typeof item.path !== 'string') {
      continue
    }

    const mappedId = mapDirectorySkillToId(source, item.path)
    if (!mappedId || uniqueSkills.has(mappedId.id)) {
      continue
    }

    const manifestPath = `${mappedId.relativeDir}/SKILL.md`
    const docResponse = await loadRemoteText(`${source.repositoryBaseUrl}/${manifestPath}`)
    const frontMatter = parseFrontMatter(docResponse.text)
    const title = String(frontMatter.name || '').trim()

    entries.push({
      id: mappedId.id,
      name: title || mappedId.slug,
      path: `${path.posix.join(mappedId.relativeDir, '')}`,
      url: `${source.pagesBaseUrl}/${mappedId.relativeDir}/`,
      owner: mappedId.owner,
      slug: mappedId.slug,
      runtime: normalizeStringArray(frontMatter.runtime, 'runtime'),
      tags: normalizeStringArray(frontMatter.tags, 'tags'),
      updatedAt: docResponse.lastModified || new Date().toISOString(),
    })
    uniqueSkills.add(mappedId.id)
  }

  return entries
}

function mapMarketplaceSkillToId(source, rawSkillRef) {
  const normalized = rawSkillRef.replace(/^\/+/, '').replace(/\/+$/, '')
  const withoutPrefix = normalized.replace(/^\.\//, '')
  const skillPath = withoutPrefix.startsWith('skills/') ? withoutPrefix.slice('skills/'.length) : withoutPrefix
  const parts = skillPath.split('/').filter(Boolean)

  if (!parts.length || parts.length > 2) {
    return undefined
  }

  const slug = parts.at(-1)
  const owner = parts.length === 2 ? parts[0] : source
  const id = parts.length === 2 ? `${source}:${parts[0]}/${parts[1]}` : `${source}:${parts[0]}`

  return {
    source,
    slug,
    owner,
    id,
    relativeDir: `skills/${parts.join('/')}`,
  }
}

function mapDirectorySkillToId(source, rawPath) {
  const registryRoot = source.skillsDirectoryPath.replace(/^\/+/, '').replace(/\/+$/, '')
  const normalized = rawPath.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!normalized.startsWith(`${registryRoot}/`)) {
    return undefined
  }

  const relative = normalized.slice(`${registryRoot}/`.length)
  const parts = relative.split('/').filter(Boolean)
  if (!parts.length || parts.length > 2) {
    return undefined
  }

  const slug = parts.at(-1)
  const owner = parts.length === 2 ? parts[0] : source.id
  const id = parts.length === 2 ? `${source.id}:${parts[0]}/${parts[1]}` : `${source.id}:${parts[0]}`

  return {
    source: source.id,
    slug,
    owner,
    id,
    relativeDir: normalized,
  }
}

async function loadRemoteText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
    },
  })

  if (!response.ok) {
    throw new Error(`Unable to fetch ${url}`)
  }

  const text = await response.text()
  const lastModified = response.headers.get('last-modified') || undefined
  return { text, lastModified }
}

function parseFrontMatter(input) {
  if (!input || typeof input !== 'string') {
    return {}
  }

  const lines = input.split(/\r?\n/)
  if ((lines[0] || '').trim() !== '---') {
    return {}
  }

  const frontmatterLines = []
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === '---') {
      break
    }
    frontmatterLines.push(lines[index])
  }

  return parseYaml(frontmatterLines.join('\n'))
}

async function loadExistingIndex() {
  try {
    const raw = await fs.readFile(SEARCH_INDEX_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid index format')
    }

    return parsed
      .map((entry) => sanitizeRecord(entry))
      .filter(Boolean)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  } catch {
    return []
  }
}

async function getChangedSkillIds(before, after) {
  if (!before || !after || before === ZERO_SHA || after === ZERO_SHA) {
    return null
  }

  try {
    const diff = await runGit(['diff', '--name-status', `${before}..${after}`, '--', 'skills/*/*/**'])
    if (!diff.trim()) {
      return new Set()
    }

    const changed = new Set()
    for (const rawLine of diff.split('\n')) {
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      const parts = line.split('\t')
      const filePaths = [parts[1], parts[2]].filter(Boolean)

      for (const filePath of filePaths) {
        const match = parseSkillPath(filePath)
        if (!match) {
          throw new Error(`Invalid changed file path: ${filePath}`)
        }
        changed.add(match)
      }
    }

    return changed
  } catch {
    return null
  }
}

async function readDirectoryEntries(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }

  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const name = entry.name
    if (name === '.git' || name.startsWith('.')) {
      continue
    }
    result.push(name)
  }

  return result
}

async function writeIndex(nextIndex) {
  const clean = normalizeIndex(nextIndex)
  const next = JSON.stringify(clean, null, 2) + '\n'

  let previous = ''
  try {
    previous = await fs.readFile(SEARCH_INDEX_PATH, 'utf8')
  } catch {
    previous = ''
  }

  if (previous === next) {
    return false
  }

  await fs.mkdir('search', { recursive: true })
  await fs.writeFile(SEARCH_INDEX_PATH, next, 'utf8')
  return true
}

function normalizeRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }

  const runtime = normalizeStringArray(entry.runtime, 'runtime')
  const tags = normalizeStringArray(entry.tags, 'tags')

  return {
    id: String(entry.id || '').trim(),
    name: String(entry.name || '').trim(),
    path: String(entry.path || '').trim(),
    url: String(entry.url || '').trim(),
    owner: String(entry.owner || '').trim(),
    slug: String(entry.slug || '').trim(),
    runtime,
    tags,
    updatedAt: String(entry.updatedAt || '').trim(),
  }
}

function normalizeIndex(entries) {
  return entries
    .map((entry) => normalizeRecord(entry))
    .filter((entry) => {
      return entry && entry.id && entry.name && isValidSearchIndexIdentifier(entry.id)
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

function normalizeStringArray(value, field) {
  if (value === undefined) {
    return []
  }

  if (typeof value === 'string') {
    return [value]
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${field}; expected string or array`)
  }

  const list = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`Invalid ${field}; item must be string`)
    }
    const text = item.trim()
    if (!text) {
      continue
    }
    list.push(text)
  }

  return list
}

async function fileUpdatedAt(filePath) {
  try {
    const output = await runGit(['log', '-1', '--format=%cI', '--', filePath])
    return output || new Date().toISOString()
  } catch {
    return new Date().toISOString()
  }
}

function isMainRef(fullRef, defaultBranch) {
  const targetBranch = defaultBranch || 'main'
  if (!fullRef) {
    return false
  }

  const normalized = fullRef.startsWith('refs/') ? fullRef : `refs/heads/${fullRef}`
  return normalized === `refs/heads/${targetBranch}`
}

function parseSkillPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  const match = /^skills\/([^/]+)\/([^/]+)\//.exec(normalized)
  if (!match) {
    return null
  }
  const owner = match[1]
  const slug = match[2]
  return `${owner}/${slug}`
}

function manifestPathForId(id) {
  const [owner, slug] = String(id).split('/')
  return path.join('skills', owner, slug, 'skill.yaml')
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidIdentifier(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
}

function isValidSearchIndexIdentifier(value) {
  if (isValidIdentifier(value)) {
    return true
  }

  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(value)
}

function parseYaml(input) {
  const lines = input.split(/\r?\n/)
  const result = {}
  let currentKey

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (!line || /^\s*#/.test(line)) {
      continue
    }

    const listMatch = /^\s*-\s*(.*)$/.exec(line)
    if (listMatch && currentKey) {
      const listValue = parseScalar(listMatch[1])
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = []
      }
      result[currentKey].push(listValue)
      continue
    }

    currentKey = undefined

    const kvMatch = /^([^:#\s][^:]*)\s*:\s*(.*)$/.exec(line)
    if (!kvMatch) {
      continue
    }

    const key = kvMatch[1].trim()
    const value = kvMatch[2]
    if (value === '') {
      result[key] = []
      currentKey = key
      continue
    }

    result[key] = parseScalar(value)
  }

  return result
}

function parseScalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }

  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true'
  }

  if (trimmed === 'null' || trimmed === '~') {
    return null
  }

  const maybeNumber = Number(trimmed)
  if (!Number.isNaN(maybeNumber) && String(maybeNumber) === trimmed) {
    return maybeNumber
  }

  return trimmed
}

async function runGit(args, cwd = process.cwd()) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function loadEventMetadata() {
  if (!EVENT_PATH) {
    return {}
  }

  const payload = JSON.parse(await fs.readFile(EVENT_PATH, 'utf8'))
  return {
    before: payload.before,
    after: payload.after,
    repository: payload.repository,
    ref: payload.ref,
  }
}
