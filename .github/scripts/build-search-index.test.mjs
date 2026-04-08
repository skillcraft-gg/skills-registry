import assert from 'node:assert/strict'
import { describe, test, mock } from 'node:test'
import { loadExternalRegistry } from './build-search-index.mjs'

describe('build-search-index external registries', () => {
  test('loads directory-backed external registry entries', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
      if (url === 'https://api.github.com/repos/openai/skills/contents/skills/.curated') {
        return createJsonResponse([
          { type: 'dir', path: 'skills/.curated/openai-docs' },
          { type: 'dir', path: 'skills/.curated/security-best-practices' },
          { type: 'file', path: 'skills/.curated/README.md' },
        ])
      }

      if (url === 'https://raw.githubusercontent.com/openai/skills/main/skills/.curated/openai-docs/SKILL.md') {
        return createTextResponse(`---
name: OpenAI Docs
runtime:
  - codex
tags:
  - docs
---

# OpenAI Docs
`, 'Mon, 01 Apr 2024 00:00:00 GMT')
      }

      if (url === 'https://raw.githubusercontent.com/openai/skills/main/skills/.curated/security-best-practices/SKILL.md') {
        return createTextResponse(`---
name: Security Best Practices
runtime:
  - codex
tags:
  - security
---

# Security Best Practices
`, 'Tue, 02 Apr 2024 00:00:00 GMT')
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    try {
      const entries = await loadExternalRegistry({
        id: 'openai',
        directoryListingUrl: 'https://api.github.com/repos/openai/skills/contents/skills/.curated',
        skillsDirectoryPath: 'skills/.curated',
        repositoryBaseUrl: 'https://raw.githubusercontent.com/openai/skills/main',
        pagesBaseUrl: 'https://github.com/openai/skills/blob/main',
        repository: 'openai/skills',
        ref: 'main',
      })

      assert.deepStrictEqual(entries, [
        {
          id: 'openai:openai-docs',
          name: 'OpenAI Docs',
          path: 'skills/.curated/openai-docs',
          url: 'https://github.com/openai/skills/blob/main/skills/.curated/openai-docs/',
          owner: 'openai',
          slug: 'openai-docs',
          runtime: ['codex'],
          tags: ['docs'],
          install: {
            type: 'github-directory',
            repo: 'openai/skills',
            ref: 'main',
            path: 'skills/.curated/openai-docs',
          },
          updatedAt: 'Mon, 01 Apr 2024 00:00:00 GMT',
        },
        {
          id: 'openai:security-best-practices',
          name: 'Security Best Practices',
          path: 'skills/.curated/security-best-practices',
          url: 'https://github.com/openai/skills/blob/main/skills/.curated/security-best-practices/',
          owner: 'openai',
          slug: 'security-best-practices',
          runtime: ['codex'],
          tags: ['security'],
          install: {
            type: 'github-directory',
            repo: 'openai/skills',
            ref: 'main',
            path: 'skills/.curated/security-best-practices',
          },
          updatedAt: 'Tue, 02 Apr 2024 00:00:00 GMT',
        },
      ])
    } finally {
      fetchMock.mock.restore()
    }
  })
})

function createJsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload
    },
    headers: {
      get() {
        return null
      },
    },
  }
}

function createTextResponse(text, lastModified) {
  return {
    ok: true,
    async text() {
      return text
    },
    headers: {
      get(name) {
        return name.toLowerCase() === 'last-modified' ? lastModified : null
      },
    },
  }
}
