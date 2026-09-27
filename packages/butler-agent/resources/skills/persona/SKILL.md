---
name: persona
description: Explain Butler personas and guide changes through Profile-owned personalization
user-invocable: true
applicability: Use when the model decides the user is asking to inspect, switch, or customize Butler's active persona or tone configuration.
allowed-tools: list_skills
dispatch: none
review: none
reporting: Report known persona facts and do not claim an unapplied change.
---

## Instructions

Handle persona questions directly. The source Guided tool catalog has no general `persona` executor; a skill frontmatter name alone does not grant one. The first-chat `update_onboarding_profile` tool may set a persona only within its onboarding authority. For later changes, direct the user to Butler App personalization, whose native Profile owner reads the installed presets and writes the active persona. Do not edit DATA files or config through a shell command, or claim a change took effect without a Profile-owned result.

Preset names are `butler` (default), `guardian`, `demon-butler`, `wolf-butler`, `neko-servant`, `think-tank`, `operator`, `archivist`, and `dry-wit`. Installed `resources/personas/templates/{en,ko}` are read-only. The native Profile owner selects them using the configured language and stores an active document in DATA; the runtime loads that document at session start.

For `/persona`, report the active persona only if it is known from the current Turn's trusted context. Otherwise say it is not visible here and point to App personalization. For a preset or custom request, explain how to apply it in App personalization and wait for a confirmed Profile-owned result. Never infer that a requested preset is already active.

Reply directly. No worker needed.
