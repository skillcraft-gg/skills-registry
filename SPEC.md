# Skills Registry Specification

## Purpose

The skills repository hosts the canonical registry of installable skills.

Site published at:

skillcraft.gg/skills (rendered by skillcraft-gg.github.io)

---

## Identifier Format

Local registry IDs:

`owner/slug`

External marketplace IDs are not local registry IDs. These may appear in external
search index entries only:

`~source/<slug>`
`~source/<owner>/<slug>`

Example:

blairhudson/threat-model

Search index external sources are declared as individual JSON files under
`skills/external/*.json`. Each file should contain:

- `id`
- `marketplaceUrl`
- `repositoryBaseUrl`
- `pagesBaseUrl`

The build script discovers all `*.json` files in that directory and fails
the run if any file is invalid or missing required fields.

---

## Repository Layout

skills/
/
/
SKILL.md
skill.yaml
scripts/
references/
assets/

---

## Skill Definition

Example:

```yaml
id: blairhudson/threat-model
name: Threat Model
owner: blairhudson
runtime:
  - opencode
tags:
  - security


⸻

Validation

GitHub Actions validate:
	•	SKILL.md presence
	•	Agent Skills compliance
	•	identifier format
	•	schema validity

⸻

Publishing

Skills are submitted via PR.

CLI command:

skillcraft skills publish <owner>/<slug>


⸻

GitHub Pages

Published at:

skillcraft.gg/skills (rendered by skillcraft-gg.github.io)

Source of truth:

The registry data in this repository.

Routes:

/skills/<owner>/<slug>

---

# `loadouts/SPEC.md`

```markdown
# Loadouts Registry Specification

## Purpose

Defines bundles of skills.

Site published at:

skillcraft.gg/loadouts

---

## Identifier Format

/

Example:

blairhudson/secure-dev

---

## Repository Layout

loadouts/
/
/
loadout.yaml

---

## Loadout Definition

```yaml
id: blairhudson/secure-dev
name: Secure Dev
skills:
  - blairhudson/threat-model
  - skillcraft-gg/code-review


⸻

Validation

Actions verify:
	•	referenced skills exist
	•	identifier format
	•	schema compliance

⸻

GitHub Pages

Published at:

skillcraft.gg/loadouts

Routes:

/loadouts/<owner>/<slug>
