# Memory wiring audit

Audit of `codex/wiring-audit`, Linux x86_64, 2026-10-02. Production code is
unchanged. Evidence paths below are relative to `crates/`. CONFIRMED requires
a completed user-facing runtime reproduction; FINE means a production caller
was found, not that every behavior or performance property was validated.

The inventory uses the checked-in Rust facade/domain documentation, installed
skills, `plans/post-0.1.0/02-embedding-model.md`, and E2E scenarios. The owner's
canonical Project Ledger was not accessed. The README references `SCENARIOS.md`
and `PROVIDER_CONFIG.md`, but those files are absent from this checkout.

## Findings

| Capability | Status | Production evidence / missing link | User-visible effect | Failing stub E2E in `butler-e2e/tests/memory_wiring.rs` |
| --- | --- | --- | --- | --- |
| Native status memory estimate | CONFIRMED | `butler-agent/src/host/cli/status.rs:98` calls `butler-runtime/src/operations/status_summary/context.rs:125`, which reads `memory/user-profile.md`, `memory/hot/cache.md`, `memory/rules/INDEX.md`. Live rules use `cognition/memory/rules`, bound at `butler-agent/src/host/runtime/boundary.rs:150`. | Successfully saved memory contributes zero tokens to `butler status`; total/used/free estimates undercount it. | `wiring_status_counts_saved_explicit_memory` |
| Daily capsule for App projects | CONFIRMED | App insertion: `butler-gateway/src/gateway/application/projects/rows.rs:158`; daily refresh: `butler-agent/src/host/memory_jobs/maintain_phase.rs:86`; registry reader: `butler-memory/src/cognition/project_capsule/source.rs:123` reads only config `projects[].name`. | App project remains without its Project Memory capsule after configured health completes. | `wiring_daily_capsule_includes_app_registered_project` |
| Project scope of mandatory explicit rules | CONFIRMED | Writer stores project binding at `butler-agent/src/host/guided/tools/memory_write.rs:127`; the input documents project ownership at `butler-memory/src/cognition/sources/typed/write.rs:33`. `butler-runtime/src/context/prompt/files.rs:37` reads every indexed rule without its binding; `context/prompt/sections.rs:229` injects all as user-scoped mandatory context. | A rule explicitly requested for this project only becomes an Active Rule in an unrelated general chat. | `wiring_project_rule_stays_out_of_general_prompt` |
| Retained MCP graph query | CONFIRMED | `butler-agent/src/host/mcp/server.rs:311` advertises graph queries; `host/mcp/graph.rs:12` calls `butler-memory/src/cognition/mcp_graph.rs:94`, which rejects any active v2 descriptor. | Every fresh installation returns `Graph unavailable: legacy_memory_writer_disabled_for_v2`; MCP wraps the diagnostic in a success result. | `wiring_mcp_graph_accepts_fresh_generation` |

Fixture comparison: capsule unit test `butler-memory/src/cognition/project_capsule/tests.rs:69`
writes the old config registry directly. Prompt tests at
`butler-runtime/src/context/prompt/tests.rs:345` write unscoped rule text/index,
so they cannot detect project leakage. Existing `butler-e2e/tests/memory.rs:19`
checks physical persistence, and MEM-02 checks inclusion, not exclusion from
another project. The new scenarios start with `Fixture::Empty`, await the
production active-generation descriptor, and create no memory fixtures.
Only the two chat scenarios complete non-memory onboarding; model selection
uses the settings API. Provider responses are local replay/synthetic stubs.
The capsule scenario creates a project/session through HTTP, advances the
supported stub clock, restarts, and waits for the real daily completion marker
and a successful configured health event. An absent file alone is insufficient
evidence; the event proves the refresh phase ran.

## Production inventory

`AgentRuntime::open` constructs the memory owners at
`butler-agent/src/host/runtime.rs:92,114,130,135,140,168,196,208`.
The service starts daily maintenance after readiness at
`butler-agent/src/host/service/entrypoint.rs:358`. The completion consumer starts
inside `MemorySync::open`; fresh initialization runs in its owned task before
polling (`host/memory_jobs/sync.rs:150,164`).

| Capability | Status | Caller / trigger and data binding |
| --- | --- | --- |
| Fresh generation creation | FINE | Runtime bootstrap → `MemorySync` → `FreshMemoryGeneration::initialize`, above. Existing MEM-03 tests cover nonblocking readiness and nonfresh preservation. |
| Rules prompt root | FINE | `runtime/boundary.rs:150` binds the same explicit root as `sources/typed/write.rs:194`; inclusion is fixed. Scope is the separate finding above. |
| Active hot cache | FINE | `butler-memory/src/cognition/completion/consumer/process/cache.rs` is called from consumer processing; prompt port `butler-agent/src/host/guided/cognition_prompt.rs:50` reads the active generation. Existing `memory_hot_cache.rs` uses production bootstrap. |
| Profile projection | FINE | Runtime-owned Profile → `butler-runtime/src/context/prompt/sections.rs:125`; projection comes from Profile DB, rather than a fixture-only markdown writer. |
| Project capsule prompt | FINE | `host/guided/cognition_prompt.rs:74` → prompt reader → `cognition/memory/projects/<project>.md`; default App refresh registry is CONFIRMED above. |
| Recent feedback prompt | FINE (reader only) | `context/prompt/sections.rs:242` → `host/guided/cognition_prompt.rs:27` → `butler-memory/src/cognition/prompt/feedback.rs:176`, reading `cognition/feedback/feedback.md`. Ingress/promotion is SUSPECT below. |
| Session continuity prompt | SUSPECT | `butler-memory/src/cognition/prompt/memory.rs:33` reads `memory/sessions/<session-hash>.md`; no writer of that directory found. Continuity recovery instead writes a workspace project hot cache (`continuity_recovery/workspace.rs:38`). |
| Recall tool | FINE (composition only) | Runtime `MemoryRecall` plus vector adapter → `host/guided/tools/dispatch.rs:394`. Expansion/ranking and alias storage deliberately excluded. |
| Exact query / exact source reads | FINE (composition only) | Runtime `ExactMemoryQuery` and `MemorySourceReader` → `host/guided/tools/dispatch.rs:404` and conversation reference owner. |
| MCP graph query | CONFIRMED | Standalone `mcp serve` exposes `memory_graph`; the fresh v2 descriptor is rejected by its legacy-only reader, above. |
| Explicit saves | FINE | Tool `host/guided/tools/memory_write.rs:120` → durable rule/text binding/index → typed completion notice. New status and scope tests prove successful saves. |
| Explicit forgetting / replacement | SUSPECT | Domain recognizes forgotten/superseded bindings (`butler-memory/src/cognition/sources/typed.rs:59`); public write adapter exposes only a new rule, with a new call-derived record ID. No user-facing retraction caller found. |
| Task memory ingestion | FINE (composition only) | Tool `host/guided/tools/memory_write.rs:68` → reviewed WorkRecord → `sources/typed/write/task.rs:20` → `cognition/memory/tasks/*.md` plus typed queue notice. Capsule Work consumption remains SUSPECT. |
| Completion registration / semantic graph / cache | FINE | `MemorySync` poll → `completion/consumer/process.rs:105,186,355` → registration/project-next/cache stages. Typed rules/task reports dispatch through `process/typed.rs:31`. |
| Vectors | FINE (composition only) | Runtime adapter/embedding owner passed into `MemorySync`; `completion/consumer/process/vector.rs` runs after semantic work. Missing assets defer work, rather than proving a permanently unavailable fresh identity. Known migrated-identity defect is excluded. |
| Catch-up | FINE | Poll calls `completion/consumer/catchup.rs:30`; daily session sync and configured Catchup also call it. Reads canonical outcome/recovered inventories and records progress; no fixture-written trigger required. |
| Daily session sync | FINE | `context_maintenance.rs:89` → `daily_schedule.rs:19` → `daily.rs:146`; descriptor-present routes to catch-up, otherwise legacy sync. |
| Daily consolidation trigger | FINE | `context_maintenance.rs:105` → local day / minute ≥04:00; missing marker is due, production writes its marker on completion. Capsule E2E exercises this trigger. |
| Configured catchup/consolidate/optimize/health | FINE (composition only) | `daily.rs:216` → `maintain_phase.rs:33,50,61,83`. `configured_cycle.rs:108` defaults enabled. Optimize explicitly reports missing vector store as unavailable. |
| Profile transcript consolidation | FINE | `profile_consolidation.rs:46,60` calls Profile extraction/consolidation subject to consent. Feedback-driven consolidation is separately SUSPECT. |
| Box indexing/retention and legacy metadata integrity | FINE (maintenance only) | `consolidation_phase.rs:40,52,127`; Box entry/operator ingestion not established. |
| Legacy transcript/query/hot-cache index | FINE (legacy composition only) | `host/memory_jobs/transcript_sync.rs:41,142,159` constructs `LegacyIndexService`, parses transcripts, indexes legacy query/vector/hot outputs on the descriptor-absent daily path. Active v2 uses the consumer instead. Public `LegacyIndexService::backfill` has no agent caller. |
| Know-how quality aggregation/revision | FINE (maintenance only) | `consolidation_phase.rs:64,83` calls `KnowHowService`; model-facing retrieval/prompt consumption not established. |
| Memory health tool | FINE | `host/guided/tools/monitoring.rs:139` → `MemoryHealthService::read_tool` with profile coverage. `memory_health/serving.rs:24` reads active graph/cache; outer legacy counts are explicitly documented as legacy. |
| New-chat briefing / metrics / feedback triage | FINE (composition only) | Daily generic phases in `consolidation_phase.rs:35,115,120`; runtime briefing source includes App projects independently of the old capsule registry. |
| Legacy namespace/import / continuity repair / generation operator controls | SUSPECT or known | Exported library services have no agent constructor/caller. Refusal of pre-BTCC App data is intentional (MIG-01); prepare/activate rebuild is the already-known fifth defect, not a new finding. |

## Suspects and what would settle them

| Candidate | Evidence | Why not CONFIRMED / smallest settling experiment |
| --- | --- | --- |
| Feedback → profile candidate promotion | `host/memory_jobs/profile_consolidation.rs:29,93` counts candidates but hardcodes applied count zero; captures transcripts only. `butler-memory/src/cognition/feedback_buffer/operator.rs:58` has no agent caller. | No supported stub user ingress to that buffer found. Establish intended public correction route, create feedback through it, enable consent, await the daily profile checkpoint, and inspect candidate/applied state. Manually seeding feedback would hide this missing ingress. |
| Box/know-how/feedback operator features | No agent callers of `box_store/operator.rs:116` (forget), `knowhow_store/operator.rs:74` (retrieve), `feedback_buffer/operator.rs:58` (add). Prompt assembler has no KnowHow port/section. | `butler-e2e/tests/cli_surface.rs:89` deliberately retires cognition CLI commands. Library APIs alone do not prove these are still product promises. Needs owner spec identifying supported save/retrieve/forget routes, then a fresh-data tool E2E. |
| Capsule sources after registry is repaired | `project_capsule/source/tasks.rs:29` reads flat `tasks/*`; `source/graph.rs:25` reads `memory/db/graph.sqlite` and old `entity_mentions/entities`; `source/evidence.rs:98` reads `rules/projects`, while explicit writer uses flat `rules/<id>.md`. | Registry defect masks these in normal App usage. Smallest next probe: register through a supported config command, create reviewed Work/project rules through tools, await daily health, compare capsule with current Work Records/active graph. No artificial memory seeding. |
| Continuity repair / legacy migration/import | No `ContinuityRecoveryService`, `CognitionNamespaceMigrationService`, `LegacyMemoryImportService` references in `butler-agent/src`; exports at `butler-memory/src/cognition.rs:50,84,123`. | Fresh data cannot demonstrate loss of existing legacy state; pre-BTCC App refusal is explicitly permitted. Need a supported post-BTCC legacy input and documented upgrade/repair trigger. |
| Session continuity notes | `butler-memory/src/cognition/prompt/memory.rs:33` reads hashed session files; no corresponding production writer found. | Need owner requirements naming when continuity notes should be created; run that trigger in a fresh conversation, await a durable completion barrier, inspect the next prompt. Project hot-cache recovery is a different output and cannot establish this reader's wiring. |
| Explicit rule update/forget | Domain input permits record ID (`sources/typed/write.rs:29,85`), but tool passes neither old record ID nor retraction; `sources/typed.rs:59` only consumes lifecycle already written elsewhere. | Need intended tool contract for replacing/forgetting a saved rule. Existing supersession tests invoke internal/domain state, not the public adapter. |
| Failed generation recovery / extractor change / rollback | Exports `butler-memory/src/cognition.rs:106`; no agent calls to retry/repair/set-extractor/rollback. | Same removed operator surface caveat; prepare/activate is already known. Need supported recovery UI/tool and a naturally failed generation before claiming a new user-visible failure. |

## Validation and limits

`memory_wiring` ran with four test threads: **0 passed, 4 failed as intended**,
in **13.13 s** (final run; initial run **14.33 s**). Every failure reached the final product assertion, with no
provider mismatch, readiness failure, or completion watchdog failure:

- Status: before **0**, after **0**; saved rule INDEX alone requires **27** tokens.
- Capsule: App registered **1** project; successful configured health considered
  **0**, refreshed **0**, and produced no capsule.
- Scope: stored project binding matched the App project; the unrelated general
  prompt's mandatory Active Rules contained the project fact.
- MCP: JSON-RPC succeeded but text was
  `Graph unavailable: legacy_memory_writer_disabled_for_v2`, not graph JSON.

Agent dev build passed in **8m 35s**. The first new-test compilation found two
harness error-conversion mistakes, corrected before the runtime run. Tightening
the scope scenario to a project-only instruction exposed a replay nonce-key
mismatch (two targeted runs failed before the product assertion); the key and
argument stub were corrected, with the exclusion assertion preserved.
No production test was weakened or retried to obtain a pass.
Existing stub E2Es passed: `mem_01_chat_memory_source_survives_restart`
(**8.37 s**), `mem_02_fresh_memory_is_usable_in_another_chat_after_restart`
(**8.51 s**), `mem_hot_active_refresh_reaches_another_chat` (**9.69 s**),
`prj_first_turn_initializes_ledger` (**19.88 s**), and
`cli_surface_exposes_only_user_commands` (**6.56 s**).
`cargo fmt --all` and `cargo fmt --all -- --check` passed.
`cargo clippy --locked -p butler-e2e --all-targets -j 8 -- -D warnings`
passed (**22.85 s**). `cargo run --locked -p butler-source-check -j 8 -- .`
passed: **2,186** Rust files, zero function-length/platform/test-ratchet,
architecture, model-literal or E2E gate violations. All cargo checks/tests used
fresh `HOME` and `BUTLER_DATA`, retained the real cargo/rustup caches, and ran
sequentially with at most eight build jobs and four scenario threads.
No live provider calls, real DATA reads, service changes, or production edits.
Recall expansion/ranking, alias postings, and host/service lifecycle were read
only as needed to locate composition; their behavior was not audited. Embedding
quality, asset distribution, model-dependent extraction/consolidation accuracy,
owner-scale performance, Windows/macOS, and actual supported legacy upgrades
are not established by these fresh-folder stub reproductions.
