# Preview decisions: Ledger publication queue, 2026-10-02

Canonical target: Project Ledger project `butler`. This file is a publication queue, not a canonical Ledger update or acceptance record.

The canonical CLI `packages/project-ledger/bin/project-ledger status --project "$PWD" --json`, run with fresh temporary HOME and BUTLER_DATA, returned `not_initialized`. No owner data was read and no replacement project was initialized. Publish through the canonical CLI in an authorized initialized copy; preserve existing record IDs, history and milestones.

## Entries to publish

Update `PLAN-0-1-0-REMAINING` and the related plans below with these decisions from 2026-09-30 through 2026-10-02. Evidence is merged code in `origin/main` at `53fa0a3130da5e4181d9ed163ab2bbe874fc7ce3`, unless a published release is named. A merged change is not completion of every original acceptance item.

| Target record | Entry and milestone disposition | Evidence |
| --- | --- | --- |
| `PLAN-0-1-0-03` | Public CLI is slimmed to implemented routes, includes `--version`/`-V`, local remote management, 8-digit pairing and revocable devices. Document `user.responseLanguage` and `update.previews`. Retain any remaining lifecycle acceptance separately. | `6ec25fa7c`, `c8c266761`, `b4f59f3d9`, `36c3d0364` |
| `PLAN-0-1-0-04` | Preview updates default OFF and are shared by App/CLI. Full prerelease versions are preserved. In-app updates install App and bundled Agent and relaunch with the same data directory on macOS/Linux. | `c773eb3f3`, `d99062bc8`, `3d6eb6d04` |
| `PLAN-0-1-0-08` | Progressive skill disclosure is implemented: name/description first, full skill and supporting files on demand. Publish the previously hidden KO/EN Skills pages. | Existing plan completion; `butler-runtime/src/skills` and guided `load_skill` path |
| `SPEC-BUTLER-0-1-0` | First run orders interface language, required consent, AI connection and reply language. Memory model downloads in the background. Approval risk fails closed and command examples retain full text up to a marked 16 KiB cap. `ask_user` uses the composer question form. | `3b11acffa`, `6a749d549`, `ebed9d3b8`, `ae0e3adc9`, `966282478` |
| `PLAN-POST-0-1-0` (P2), `PLAN-EMBEDDING-MODEL` | Fresh generations bootstrap explicit remembered rules and recall; semantic projection refreshes the active hot cache. Compatible serving vector identities are adopted; unrelated identities remain refused. These merged fixes do not complete all P2 storage, catch-up, batching and index work. | `0e647732b`, `cb6b035a7`, `89f0db12f`, `3238cb3b4`, `f73c774a2`, `3e24fb034` |
| `PLAN-0-1-0-04`, `SPEC-BUTLER-0-1-0` | Runtime estimated costs separate conversation, memory and other work while preserving installation totals. Pricing gaps remain unavailable. Settings currently shows tokens/provider usage, without a separate cost-by-work table. | `9dbe65c83`; runtime `operations/status_summary/usage/buckets.rs`, App `UsageSettings.tsx` |
| `PLAN-0-1-0-03`, `SPEC-BUTLER-0-1-0` | Detached CLI supervisor recovers abnormal exits without a service manager, capped at five crashes per minute; clean stop stays stopped. Same-DATA self-restart and interrupted-turn recovery are implemented. `doctor --collect-logs` exports service logs and `summary.txt`, excluding model-turn logs. | `d3cb49f6c` |
| `PLAN-0-1-0-11`, `PLAN-POST-0-1-0` (P9) | Windows platform/source work is distinct from installation delivery. Keep Windows installer milestone pending: coming in a later preview. | Preview.5 release asset inventory has no Windows artifact; original Windows completion exclusions remain |
| `PLAN-0-1-0-12` | Preview milestone has reached published `v0.1.0-preview.5`; App/Agent asset names include `0.1.0-preview.5`. Stable `v0.1.0` remains pending separate authorization and acceptance. | Published GitHub release `v0.1.0-preview.5`; `1284a3df9`, `5e5a4c526` |
| `PLAN-0-1-0-13` | Leave owner upgrade, cleanup and canonical publication pending. This docs task did not touch the live install or owner data. | Isolated CLI `not_initialized`; task boundary |

## Canonical publication procedure

In an authorized initialized isolated Ledger copy, first run `status` and inspect existing records and milestone identities with `show`/`list`. Fold the entries into those records, preserving prior acceptance evidence. Use `plan update --project <project-path> --id <existing-ID> --from <updated-file>` for plans and `record update --kind spec --project <project-path> --id SPEC-BUTLER-0-1-0 --from <updated-file>` for the specification. Use the current CLI help for milestone updates; do not invent milestone IDs or mark owner/stable acceptance complete from these implementation notes. Then run Ledger `check` and `status`.
