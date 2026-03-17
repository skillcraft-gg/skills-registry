# Skillcraft Pages Site Specification

## Purpose

The `skillcraft-gg.github.io` repository is the canonical static site for
`skillcraft.gg` and owns rendering for public routes:

- `/`
- `/docs`
- `/skills`
- `/loadouts`
- `/credentials`

It has no runtime backend and is deployed as static assets via GitHub Pages.

## Source Repositories

The site renders route content from registry repositories during build:

- `skillcraft-gg/skills` provides skill definitions and assets.
- `skillcraft-gg/loadouts` provides loadout definitions.
- `skillcraft-gg/credentials` provides credential definitions and issued credentials.

## Build and Publish Model

The site is regenerated from source data and deployed when registries change.

- Source repos include changes that affect published definitions.
- On change, those repos dispatch events to this repository.
- Build jobs fetch the latest checked sources, validate them, and produce static pages.
- Build artifacts are deployed to GitHub Pages.

This model preserves `/` and `/docs` from `skillcraft` while ensuring registry
routes are synchronized when source changes.

## Routes

- `/`
- `/docs`
- `/skills`
- `/skills/<owner>/<slug>`
- `/loadouts`
- `/loadouts/<owner>/<slug>`
- `/credentials`
- `/credentials/users/<github>`

## GitHub Actions Rebuild Triggers

- `repository_dispatch` events from `skillcraft-gg/skills`, `skillcraft-gg/loadouts`, and `skillcraft-gg/credentials`.
- Manual workflow dispatch for explicit rebuilds.

Rebuild inputs should include changed source repo and commit information so stale
cache windows can be avoided.

## Validation and Safety

Builds must validate registry payload shape before publishing.

- required files exist
- identifier format is valid
- definitions satisfy expected schema
- cross-registry references are consistent

On validation failures, the build must fail and not publish broken routes.

## Failure Modes

- If one or more source repos are unavailable, the build should fail fast with
  clear diagnostics.
- Optional cached snapshots may be used for local development only, not for
  production publish.
