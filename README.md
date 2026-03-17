# Skills Registry

This repository is the source of truth for Skillcraft skill definitions.

## Layout

- `skills/<owner>/<slug>/SKILL.md`
- `skills/<owner>/<slug>/skill.yaml`
- optional: `scripts/`, `references/`, `assets/`

## Registry Rules

- Only pull requests are accepted.
- Changed skill namespaces must match the PR submitter.
  - A PR touching `skills/<owner>/...` must be submitted by GitHub user `<owner>`.
  - PRs modifying multiple owners are rejected.
- Required files:
  - `SKILL.md`
  - `skill.yaml`
- `skill.yaml` must include:
  - `id` (required, `<owner>/<slug>`)
  - `name` (required)
  - optional `owner`, `runtime`, `tags`
- `skill.yaml` `id` must exactly match directory path.

## Automation

- PRs are validated by GitHub Actions (`.github/workflows/validate-skill-pr.yml`).
- If validation succeeds, the workflow queues the PR to auto-merge.

## GitHub Pages

This repo is served directly as static assets on GitHub Pages. Every file under
`skills/<owner>/<slug>/` is addressable via web paths.

## Search Index

The site also exposes a generated search catalog at:

- `/skills/search/index.json`

This file is updated by GitHub Actions on every push to `main` when `skills/*/*/**`
changes, and by manual `workflow_dispatch` runs.

It contains a sorted list of local and external entries. Local IDs are
`owner/slug`. External IDs currently include `~anthropic/<slug>` and
`~anthropic/<owner>/<slug>`.

External registries are configured via JSON files under `external/`.
Each file contains `id`, `marketplaceUrl`, `repositoryBaseUrl`, and
`pagesBaseUrl`. The build script reads all `*.json` files from this
directory (sorted by filename) and fails fast if any file is invalid.
Set `SKILLCRAFT_EXTERNAL_REGISTRIES_PATH` to override that directory.

Each entry includes `id`, `name`, `path`, `url`, `owner`, `slug`, `runtime`,
`tags`, and `updatedAt`.
