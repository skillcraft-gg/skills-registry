#!/usr/bin/env node
import fs from 'node:fs/promises'

const EVENT_PATH = process.env.GITHUB_EVENT_PATH
if (!EVENT_PATH) {
  throw new Error('GITHUB_EVENT_PATH is not set')
}

const event = JSON.parse(await fs.readFile(EVENT_PATH, 'utf8'))
const pullRequest = event.pull_request
if (!pullRequest) {
  throw new Error('Not a pull request event')
}

const repoFullName = pullRequest.base?.repo?.full_name
const pullNumber = pullRequest.number
const submitter = (pullRequest.user?.login || '').toLowerCase()
const headSha = pullRequest.head?.sha

if (!repoFullName || !pullNumber || !submitter || !headSha) {
  throw new Error('Could not read pull request metadata')
}

const errors = []
const notes = []

const changedFiles = await listPullRequestFiles(repoFullName, pullNumber)
const changedSkillFiles = changedFiles.filter((entry) => typeof entry.filename === 'string' && /^skills\//.test(entry.filename))

if (!changedSkillFiles.length) {
  notes.push('No skill files changed under skills/; nothing to validate in this workflow run.')
  notes.push(`Repository: ${repoFullName}`)
  notes.push(`Pull request: #${pullNumber}`)
  await writeSummary(notes)
  process.stdout.write('No skill entries found to validate.\n')
  process.exit(0)
}

const skillsByOwner = new Map()
for (const file of changedSkillFiles) {
  const parsed = parseSkillPath(file.filename)
  if (!parsed) {
    errors.push(`Invalid skill path layout: ${file.filename}`)
    continue
  }

  const key = `${parsed.owner}/${parsed.slug}`
  if (!skillsByOwner.has(parsed.owner)) {
    skillsByOwner.set(parsed.owner, new Set())
  }
  skillsByOwner.get(parsed.owner).add(parsed.slug)
}

if (skillsByOwner.size === 0) {
  errors.push('Changed files under skills/ do not match expected skills/<owner>/<slug>/... layout.')
}

if (skillsByOwner.size > 1) {
  errors.push(`PR touches multiple owners: ${Array.from(skillsByOwner.keys()).sort().join(', ')}`)
}

const owners = Array.from(skillsByOwner.keys())
if (owners.length === 1) {
  const owner = owners[0]
  if (owner.toLowerCase() !== submitter) {
    errors.push(`Submitter mismatch: PR author '${submitter}' does not match modified owner '${owner}'`)
  }
}

for (const [owner, slugs] of skillsByOwner.entries()) {
  for (const slug of slugs) {
    await validateSkillEntry({
      repoFullName,
      headSha,
      owner,
      slug,
      errors,
      notes,
    })
  }
}

await writeSummary(notes)

if (errors.length) {
  for (const message of errors) {
    process.stdout.write(`- ${message}\n`)
  }
  process.exit(1)
}

process.stdout.write('Skill submission validation passed.\n')

function parseSkillPath(filePath) {
  const trimmed = filePath.replace(/\\/g, '/')
  const match = /^skills\/([^/]+)\/([^/]+)\//.exec(trimmed)
  if (!match) {
    return null
  }
  return { owner: match[1], slug: match[2] }
}

async function validateSkillEntry({ repoFullName, headSha, owner, slug, errors, notes }) {
  const basePath = `skills/${owner}/${slug}`
  const manifestPath = `${basePath}/skill.yaml`
  const docPath = `${basePath}/SKILL.md`

  const manifest = await getRepoFileContent(repoFullName, manifestPath, headSha)
  if (manifest === null) {
    errors.push(`Missing required file: ${manifestPath}`)
    return
  }

  const skillDoc = await getRepoFileContent(repoFullName, docPath, headSha)
  if (skillDoc === null) {
    errors.push(`Missing required file: ${docPath}`)
    return
  }

  if (!manifest.trim()) {
    errors.push(`Empty skill definition file: ${manifestPath}`)
  }

  if (!skillDoc.trim()) {
    errors.push(`Empty skill documentation file: ${docPath}`)
  }

  let parsed
  try {
    parsed = parseYaml(manifest)
  } catch {
    errors.push(`Invalid YAML in ${manifestPath}`)
    return
  }

  if (!isObject(parsed)) {
    errors.push(`Top-level value in ${manifestPath} must be a YAML mapping`)
    return
  }

  const entryId = (parsed.id || '').trim()
  const expectedId = `${owner}/${slug}`
  if (!entryId) {
    errors.push(`${manifestPath} missing required id`)
  } else if (entryId !== expectedId) {
    errors.push(`${manifestPath} id must be ${expectedId}, got ${entryId}`)
  }

  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    errors.push(`${manifestPath} missing required name`)
  }

  if (!isValidIdentifier(entryId)) {
    errors.push(`${manifestPath} id '${entryId}' is invalid; expected <owner>/<slug> format`)
  }

  if (parsed.owner !== undefined) {
    const ownerValue = String(parsed.owner)
    if (ownerValue !== owner) {
      errors.push(`${manifestPath} owner field '${ownerValue}' must match path owner '${owner}'`)
    }
  }

  if (parsed.runtime !== undefined && !isAllowedList(parsed.runtime)) {
    errors.push(`${manifestPath} runtime must be a string or array of strings`)
  }

  if (parsed.tags !== undefined && !isAllowedList(parsed.tags)) {
    errors.push(`${manifestPath} tags must be an array of strings`)
  }

  if (!errors.some((entry) => entry.includes(`${manifestPath}`) || entry.includes(`${basePath}`))) {
    notes.push(`Validated ${basePath} for ${owner}`)
  }
}

function isAllowedList(value) {
  if (typeof value === 'string') {
    return true
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isValidIdentifier(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

    const listMatch = /^(\s*)-\s*(.*)$/.exec(line)
    if (listMatch && currentKey) {
      const listValue = parseScalar(listMatch[2])
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

function readLinkHeader(linkHeader) {
  if (!linkHeader) {
    return null
  }

  for (const segment of linkHeader.split(',')) {
    const [urlSection, relSection] = segment.split(';')
    if (!relSection || !urlSection) {
      continue
    }

    if (/rel="next"/.test(relSection)) {
      const trimmed = urlSection.trim()
      return trimmed.substring(1, trimmed.length - 1)
    }
  }

  return null
}

async function githubGetAllPages(url) {
  const items = []
  let nextUrl = url
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: requestHeaders(),
    })

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} ${await response.text()}`)
    }

    const data = await response.json()
    if (Array.isArray(data)) {
      items.push(...data)
    }

    const linkHeader = response.headers.get('link')
    nextUrl = readLinkHeader(linkHeader)
  }

  return items
}

function requestHeaders() {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error('GITHUB_TOKEN is required')
  }

  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'skillcraft-skill-validator',
  }
}

async function listPullRequestFiles(repoFullName, pullNumber) {
  const url = `https://api.github.com/repos/${repoFullName}/pulls/${pullNumber}/files?per_page=100`
  return githubGetAllPages(url)
}

async function getRepoFileContent(repoFullName, filePath, ref) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  const url = `https://api.github.com/repos/${repoFullName}/contents/${encodedPath}?ref=${ref}`
  const response = await fetch(url, {
    headers: requestHeaders(),
  })

  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${await response.text()}`)
  }

  const payload = await response.json()
  if (payload.type !== 'file' || typeof payload.content !== 'string') {
    return null
  }

  return Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8')
}

async function writeSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) {
    return
  }

  const output = ['# Skill registry validation', '', ...lines.map((line) => `- ${line}`), ''].join('\n')
  await fs.writeFile(summaryPath, output)
}
