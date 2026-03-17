#!/usr/bin/env node
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const eventPath = process.env.GITHUB_EVENT_PATH
if (!eventPath) {
  throw new Error('GITHUB_EVENT_PATH is not set')
}

const event = JSON.parse(await fs.readFile(eventPath, 'utf8'))
const pullRequest = event.pull_request
if (!pullRequest) {
  throw new Error('Not a pull request event')
}

if (pullRequest.state !== 'open' || pullRequest.locked || pullRequest.draft) {
  process.stdout.write(`Skipping merge for non-open PR #${pullRequest.number}\n`)
  process.exit(0)
}

const repoFullName = pullRequest.base?.repo?.full_name
const prNumber = String(pullRequest.number)

if (!repoFullName || !prNumber) {
  throw new Error('Could not read pull request metadata')
}

if (pullRequest.merged) {
  process.stdout.write(`PR #${prNumber} already merged\n`)
  process.exit(0)
}

runGhCommand([
  'pr',
  'merge',
  prNumber,
  '--repo',
  repoFullName,
  '--squash',
  '--auto',
  '--delete-branch',
])

process.stdout.write(`Scheduled auto-merge for PR #${prNumber} in ${repoFullName}\n`)

function runGhCommand(args) {
  try {
    execFileSync('gh', args, {
      stdio: 'inherit',
      encoding: 'utf8',
    })
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    throw new Error(`Failed to merge PR ${prNumber}: ${message}`)
  }
}
