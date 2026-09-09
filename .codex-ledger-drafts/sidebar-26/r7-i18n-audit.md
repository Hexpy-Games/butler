# R7 centralized interface-language implementation audit

## Scope and refined contract

This implements the R7 interface-language part of `r7-plan.md`. Interface language and response language are independent preferences. A UI label is rendered from the interface locale; authored user/model content, document titles, filenames, command summaries, provider names, identifiers, and historical untagged activity text are not translated or language-guessed. Response-language resolution and assistant fallback prose remain response-locale responsibilities (root implementation).

One runtime-neutral, browser-safe catalog lives in `packages/butler-i18n/src`: explicit public `index.ts`, `copy-contract.ts`, complete `locales/en.ts` and `locales/ko.ts`, `locale.ts`, and bounded `interface-reference.ts`. `app/copy.ts` is the existing UI API adapter, not a second catalog. Both catalogs satisfy the same full contract; recursive parity tests also verify runtime shape. Tabular locale/contract files intentionally remain large; ownership is locale and contract, not arbitrary line ranges.

## Executed tasks and reviewed boundaries

1. Migrated existing app/first-run/backend briefing catalogs into the shared owner, removing optional-English-over-Korean fallback. New-chat briefing fallback uses settings.language, never responseLanguage.
2. Migrated reachable sidebar, toolbar, composer, settings (including skills/MCP/local models/archive/quota/native notification), onboarding/empty-state, inspector/project/document controls, approvals, read/write/search/Ledger output chrome, known API error-code presentation, notifications, and accessibility labels. Preserved authored values and internal action IDs.
3. Added UI locale subscriptions. Sidebar projection cache and React memo include locale; relative ages and date tooltips use interface locale. Completed activity projection subscribes independently; normal settings switching does not rebuild or clear user drafts. Native notification detail/settings labels are regenerated from status codes, not stale fetched prose.
4. Added deterministic progress provenance: `interface_label_key` plus retry counters, and per-field `interface_content` `{key, parameters}` for guided title/summary/nextStep. Real guided operation/phase emitters produce refs; event projection, normalization, merge, storage/replay, and UI render retain them. No bilingual rendered dictionaries are persisted. Tool target parameters are sanitized basenames or the existing safe command identity; arbitrary argument payloads are excluded.
5. Added nullable current-turn `safe_status_label_key`, parameters JSON and content JSON. Sessions expose current public provenance; historical rows are not backfilled. Terminal/retry/cancel/direct reset SQL clears provenance with labels. Authored current-status replacements clear refs. Merge selects provenance from the same state-winning label owner, rather than retaining a stale template across an authored overwrite.
6. Argument details emitted in this version use `argument_` kind provenance and central argument labels. Output counts are language-neutral numeric data; raw command details remain omitted. Authored summaries override deterministic fallback summaries without being retranslated.
7. Release manifest includes the source-only i18n module, and actual tar membership tests cover its public API, locale resolver and both catalogs. The release copier uses `manifest.requiredFiles`; `SERVICE_WORKSPACES` is not extended because this module has no workspace package/dependencies.

Root separately completed sidebar layout, response-language authority, synthetic compaction message render-time localization, Steward worker/status refs, and dynamic document metadata option catalogs. These shared-tree edits are preserved, not attributed to this worker's implementation.

## Evidence

- Final focused catalog/client/guided/operation/UI tests: **59 passed, 233 assertions**, `/tmp/r7-i18n-focused.log` (includes current-status persistence and authored-overwrite merge regressions).
- New real guided emit → shared projection → backend normalizer → current-locale UI test proves English/Korean switching on the same row and no private path in template parameters. Authored-field preservation and unknown-template rejection covered.
- Current-status integration uses the real `kernel.turnProgress.appendProgressSummaryEvent` ingress, tests SQLite template persistence and clearing on authored replacement. A preliminary test using generic appendEvent failed because that is not the status update ingress; it was corrected, not counted as product evidence.
- New authored-overwrite merge regression verifies stale templates are removed, while a completed winning row retains its provenance against an older running row.
- New-chat briefing cross-preference test: **1 passed, 17 assertions**, `/tmp/r7-briefing-test.log`.
- Service manifest and actual installable Agent tar checks passed in `/tmp/r7-i18n-packaging.log`; that combined run's initial new status test failed as described above, then passed after the ingress correction.
- Root reports actual Settings UI en↔ko switching without reload, draft retention and independent response preference; viewport/sidebar smokes 1440/800/390/320; three isolated real-provider response-language cases. Root owns their artifacts and acceptance claims.
- Temporary migration scripts (11) were removed after migration. Worker full lint passed (`/tmp/r7-i18n-lint.log`), and `git diff --check` passed. Root integration also reported lint/typecheck exit 0. Final worker typecheck outcome is reported at handoff.

## Explicit exclusions and residuals

- Historical untagged `safe_status_label`, publicTitle, model summaries and document/session names remain as stored; no text matching/backfill tries to determine authorship. A preexisting “Onboarding” session name is intentionally not renamed.
- Unknown backend/provider/tool error message bodies remain original diagnostics when no public error-code mapping exists; `app/api/request.ts` maps known codes and localizes the generic fallback. This is not a claim that arbitrary external errors are translated.
- Runtime prompts, model instructions, developer diagnostics/logging, raw provider/tool output, test fixtures, internal/legacy label compatibility sets and locale autonyms are not UI translations. `agent/output/messages.ts` uses the shared runtimeMessages catalog with response locale, not UI locale.
- Existing legacy progress helpers outside the guided operation path are not retroactively assigned provenance merely because their text looks generated. New guided phase/tool/current-sidebar/Steward paths are the validated scope; arbitrary third-party progress producers without refs retain their submitted text.
- Linux Electron packaging in the broad root suite is blocked by missing `fs-extra` in `@electron/windows-sign`; no dependency install was attempted. Root also identified an unrelated existing source-regex CreateAppServerOptions test. These are not counted as passing.
- Search was used to discover candidates, followed by call-path and render/storage review. Grep results alone do not establish complete runtime reachability or visual acceptance. No claim of all platforms visually tested is made.

## Handoff

No commit, merge, service restart or operational rollout performed by this worker. Shared-tree root owns final integration review and rollout authority. Remaining final work is verification/reporting only, not a new UI or runtime architecture.
