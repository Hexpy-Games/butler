---
name: project-ledger
description: Compatibility pointer for the packaged Project Ledger skill.
user-invocable: false
applicability: Use packages/project-ledger/SKILL.md as the canonical Project Ledger skill.
allowed-tools: project-ledger-cli
dispatch: none
review: none
reporting: Reply with bounded status, next actions, blockers, stale views, or doctor findings; do not expose raw private records.
---

# Project Ledger Compatibility Pointer

The Project Ledger implementation and canonical skill now live at
`packages/project-ledger/`.

Use:

```bash
packages/project-ledger/bin/project-ledger status --project "$PWD" --json
packages/project-ledger/bin/project-ledger query --project "$PWD" --kind next-actions --json
packages/project-ledger/bin/project-ledger check --project "$PWD" --silent
```

The legacy `packages/butler-agent/resources/skills/project-ledger/bin/project-ledger` path remains as
a repository-local compatibility shim during the package layout migration.
