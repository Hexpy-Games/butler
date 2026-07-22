# BTCC live diagnostic runner

`main.ts` is the single test entrypoint. It consumes the canonical Project
Ledger `live-scenarios.v1.json`, runs every selected model cell through
`createProductionBtccComposition`, and preserves SQLite, workspace, fixture,
Turn, operation, and report data under `.tmp/btcc-live-e2e/<run-id>`.

The runner does not call the legacy BTCC harness and does not synthesize model
phase submissions. A successful diagnostic row means the real production
composition reached the observed route, trace, final disposition, and accepted
product model identities.

It intentionally does **not** emit a canonical live-matrix pass. The current
production surface does not expose installed-App/UI driving, every provider
round identity, or the canonical semantic assertion resolvers required by
`SPEC-BTCC-PROOF-REGISTRY-AND-LIVE-MATRIX`. Reports therefore use
`butler.btcc.live-diagnostic-*.v1` and set `proofEligible: false`. The live
commands exit successfully when every row satisfies the declared diagnostic
contract; canonical proof readiness remains a separate, explicit gate.

## Fixture catalog

The authoritative scenario manifest names fixture refs but does not ship their
bytes. The readiness command deterministically generates safe, repo-local
diagnostic fixtures under `.tmp/btcc-live-e2e/fixture-catalog`. These fixtures
exercise isolation and runtime wiring, but they are not the missing canonical
fixture snapshots and therefore cannot make a row proof-eligible.

`BTCC_LIVE_FIXTURE_CATALOG` may instead point to an externally reviewed JSON
catalog with the same diagnostic transport schema:

```json
{
  "schema": "butler.btcc.live-diagnostic-fixture-catalog.v1",
  "entries": [
    {
      "ref": "fixture-template:empty-conversation-v1",
      "kind": "directory",
      "path": "fixtures/empty-conversation",
      "sha256": "<stable directory digest>"
    },
    {
      "ref": "profile-fixture:concise-korean-v1",
      "kind": "text",
      "path": "fixtures/concise-korean.md",
      "sha256": "<file sha256>"
    }
  ]
}
```

Paths are relative to the catalog. Directory hashes cover sorted relative file
paths and exact bytes; symlinks are rejected. Every setup ref in all 19
scenarios must resolve before a paid model call starts. Provider configuration
is copied from `BTCC_LIVE_SOURCE_BUTLER_DATA` (default `~/.butler`) into each
isolated scenario data root. Secrets are never written to diagnostic reports.
Live commands also require a clean feature worktree so every observation binds
one exact source revision.

## Commands

```bash
bun run test:btcc:e2e:readiness
bun run test:btcc:e2e:live:sol-low
bun run test:btcc:e2e:live:glm-medium
bun run test:btcc:e2e:live:matrix
```

The live commands never accept a scenario filter. They always execute the exact
19-scenario set for the selected exact cell, or the complete two-cell Cartesian
matrix.
