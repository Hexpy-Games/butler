# M1 context efficiency — SC01 attribution authority

Date: 2026-08-12
Task: `T-M1-V2-SEGMENT-ATTRIBUTION`
Governing spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Status and authority boundary

PR #146 owns only production SC01 provider-request attribution, focused product
tests, and the smallest authenticated Electron smoke wiring. The accepted
implementation source before benchmark-domain cleanup is
`049b24d0edd988cf058c81fd49661d44963e2e20`.

PR #142 at `63571888c3b8dba0c26b1661294fd095741b718a` and
`tests/support/agent-benchmark` are the sole fixture, provenance, campaign
planning, orchestration, eligibility, evaluation, and report authority. This
branch no longer contains an executable M1 baseline runner, fixture authority,
provenance command, aggregate schema, or wrapper alias.

The Segment Task remains done. The governing Work and Plan remain active and
`T-M1-V2-FINAL-BENCHMARK` remains todo. No final 4x3, Hermes/OpenCode run,
provider-token rerun, default-on change, merge, or optimization Task is part of
this cleanup.

## Retained production path

The real path is:

`Session Actor -> guided Turn prompt attribution -> runBtccAgentLoop ->
createModelRoutePort -> runOpenAIModelRound -> createOpenAIResponse ->
withModelApiRetry -> createOpenAIResponseOnce -> official Responses or Codex
request-body conversion -> exact final JSON serialization -> fetch -> response
usage observation`.

The default-off `BUTLER_M1_V2_SEGMENT_ATTRIBUTION` flag is read only at the
final observation boundary. Disabled or failed observation returns the same
serialized request and cannot veto, retry, reroute, or alter a Turn. Route
transport and provider retry ordinals remain separate and typed. Successful
retry or route fallback is recorded as contamination rather than eligibility.

Each physical dispatch records at most one terminal
`butler.m1-request-envelope.v2`, mutually exclusive
`butler.m1-request-segment.v2` rows whose UTF-8 bytes sum to the exact serialized
request, and at most one nullable `butler.m1-response-usage.v2`. Failed physical
attempts retain their terminal envelope. Exact carrier paths and UTF-16 spans
are bound while official Responses or Codex cumulative input is assembled; the
implementation does not infer attribution by substring search.

The typed taxonomy preserves stable role/safety, stable BTCC protocol, current
request, corrections/obligations, Work/Ledger authority, memory, phase
continuity, tool schema, latest result delivery, older replay, exact views,
Work recovery, source references, carrier overhead, and bounded other context.
No optimization, prompt replay, Work recovery, context bounding, or batching
policy is implemented by SC01.

## Retained smoke authority

`tests/support/m1-v2-segment-attribution-smoke.json` is the only #146 smoke
fixture. It composes the existing
`tests/e2e/btcc-r3-electron-driver.ts` product primitive and carries the
`direct-smoke` arm plus exact `m1-smoke-v2` cache-boundary identity. It is not a
campaign runner or benchmark fixture authority.

The accepted authenticated smoke ran once at source
`049b24d0edd988cf058c81fd49661d44963e2e20` with fresh isolated Butler data,
Electron profile, workspace and App database, ordinary non-fast
`openai/gpt-5.6-sol` reasoning `medium`, `read_only`, and the configured auth
route. It exited 0, delivered in 5,305 ms, and matched the renderer final after
reload.

The observation contained three HTTP-200 physical attempts:

| request | provider-send bytes | segment sum | usage rows |
| --- | ---: | ---: | ---: |
| Agent | 34,099 | 34,099 | 1 |
| title | 624 | 624 | 1 |
| auxiliary | 1,166 | 1,166 | 1 |
| total | 35,889 | 35,889 | 3 |

There were 3 envelopes, 14 segment rows, and 3 usage rows with zero byte-sum,
duplicate-envelope, or duplicate-usage mismatch. The Agent attempt matched the
explicit arm and cache boundary. Its bounded other share was
`339 / 34,099 = 0.994%`. Title and auxiliary attempts remained observed but
unarmed and were not mixed into arm acceptance.

Provider usage was prompt 6,834, cache-read 0, cache-write 0, and total 7,004.
Provider output and reasoning fields were unavailable and remained `null`, not
zero. All 20 M1 rows had `rawTextStored=false`; exact-needle scans found no raw
prompt, final, Turn ID, private run path, URL/query, or credential marker.

The dedicated smoke may be reproduced only when explicitly authorized, using
the existing Electron driver and this one smoke JSON. It must not be treated as
a baseline repetition or statistical acceptance result.

## Product attribution repair evidence

The immutable first landing observations exposed missing ownership for
provider-generated function-call `name` and `arguments` in Codex stateless
continuations. The repair binds those exact carrier paths as dynamic
`phase_continuity`; structural fields remain carrier overhead.

A focused BTCC-to-OpenAI three-fetch regression reproduces a 5 KB continuation
and verifies that phase continuity receives those bytes while bounded other
stays below 1 KB. A historical authenticated landing repair smoke then observed
27 eligible Agent attempts, 3,410,224 exact provider bytes, and 4,023 other
bytes (0.118%), with zero byte/cardinality mismatch. This is production-path
attribution evidence only. Its then-current build/visual/basic Work assessment
does not satisfy the later frozen quality/safety rubric owned by PR #142.

## Privacy and non-interference

Attempt digests use an installation-local random HMAC key stored with mode
0600. The key and raw input are never emitted. Observer-off tests verify that
the exact JSON is preserved and the private physical-attempt header is absent.
Observer-on tests verify capture at the product proxy and removal before
upstream forwarding. Persisted metrics contain bounded identities, keyed
digests, enums, and finite counters only—never raw prompts, transcripts, tool
payloads/results, URLs/queries, credentials, hidden reasoning, or private
paths.

Observation cannot change provider routing, retry policy, cache behavior,
request bytes, terminal state, or product completion policy. Invalid identity,
byte partition, usage, or carrier evidence fails closed for measurement without
becoming product control flow.

## Immutable historical evidence

All prior campaigns and smokes remain provenance only:

- First Butler M1 campaign: 12 observations, historical runner labels
  `9 accepted / 3 rejected / 0 gated`. The later frozen rubric makes every
  label ineligible for final acceptance; no result is reclassified here.
- Landing repair smoke: attribution and product-path evidence only, not a
  replacement campaign repetition.
- Second campaign: `3 accepted / 0 rejected / 1 gated`, followed by 8
  unscheduled observations after an archive-extraction infrastructure timeout.
  The unscheduled observations are not fabricated as gated or failed.
- PR #142 compact cross-agent campaign: all 12 observations remain rejected and
  unranked. No winner or accepted-result-per-token comparison is inferred.

The deleted #146 runner, fixtures, provenance metadata, local commands, and
aggregate implementation are recoverable from
`recovery/m1-v2-segment-attribution-pre-unification-20260812` at
`2b22e90f51274744ef0f4d9d99cc0762a52024b4`. They are not current executable
authority. Canonical fixture hashes, JSONL provenance verification, eligibility,
quality rubric, campaign manifest, and reporting now live only in PR #142.

## Validation history and cleanup gates

The accepted SC01 implementation previously passed:

- focused exact-byte, nullable usage, retry/cache/route and privacy tests;
- authenticated real Electron/App/BTCC/provider smoke;
- typecheck and lint with zero errors;
- BTCC shape and module/provider boundary audits;
- independent ordinary non-fast Sol-high review with no actionable P0-P3
  findings for the Segment implementation boundary.

Cleanup validation on the final source tree:

- affected exact-byte/privacy/nullable usage, proxy, real-driver composition,
  Guided Turn, and authority tests: 79/79 passed with 442 assertions;
- BTCC/provider module-direction tests: 26/26 passed with 3,622 assertions;
- full typecheck passed;
- full lint passed with zero errors and 19 unrelated existing warnings;
- BTCC source shape passed (`4 domains / 205 files`);
- `git diff --check`, absent duplicate tree/import/script, retained product diff,
  and report authority checks passed;
- the architecture audit script scanned 162 existing product source files and
  reported 31 size/index/generic-bucket review triggers. This cleanup changes
  none of those product files; executable module-direction tests passed;
- bounded repository-wide `bun run check` reached its 301.01-second wrapper
  timeout and was terminated with SIGTERM. No changed attribution, smoke, or
  cleanup failure appeared in the captured tail, so this is not reported as a
  pass.

A fresh independent ordinary non-fast Sol-high review of the final #142 and
#146 ownership boundary remains required before PR #146 returns to ready.

## Remaining ownership

- PR #146: production SC01 attribution, privacy/non-interference, exact-byte and
  nullable-usage tests, and one bounded real smoke composition.
- PR #142: sole benchmark harness and `T-M1-V2-FINAL-BENCHMARK` authority.
- PR #147: stacked audit record; unchanged by this cleanup.
- Next optimization Tasks: depend on PR #142 preregistered affected-arm pairs
  and must not run the full 4x3 before the Final Benchmark Task.

## T-M1-V2 tool/instruction targeted-pair preregistration

`A-M1-V2-TOOL-INSTRUCTION-SURFACE-20260812-02` is a deterministic Task 3
measurement Attempt, not the statistical Final Benchmark. It requires exactly
one eligible before and one eligible after observation for each affected arm,
in this order: `current-web-cold`, `landing-cold`, `direct-warm`, then
`direct-cold`. Statistical repetitions and the final 4x3 remain exclusively
owned by `T-M1-V2-FINAL-BENCHMARK`. Same-policy/revision serialization identity
is proven separately through the real product selection and final provider
serialization tests; no reduction or zero-regression criterion is relaxed.

The harness authority is PR #142 exact
`50e9bb9ab2b08ffac3f6772d4a3fda01f7bd8edf`. Before uses the separate clean
product checkout at
`c46aae1af1b78a6f81ea40c3099edde0ba35ebd5`; after will use a separate clean
checkout at the final product commit. Model, reasoning, auth, fixtures, rubric,
cache contract, provider route, retry eligibility, evaluator, and exact SC01
final-body segment contract remain identical across each pair. Current partial
product changes are excluded from before measurement.

One isolated replacement root per arm is allowed only for a typed
pre-render/pre-provider infrastructure failure with zero provider dispatches
and no Session, provider-request, or observation evidence. The failed root and
exclusion reason remain recorded. Replacement is forbidden after any provider
dispatch or model output, and for provider/retry, cache/route, identity,
quality, source, or product failures. Repetition of the same pre-provider
infrastructure failure stops this Attempt as a separate driver-diagnosis
blocker.

The earlier failed Attempt, plan identity
`f5ca86afd3d0268e69b61a0563e63bd48e617e9b7d7b6c4c4286b57a0f2cbb52`,
and its seven observations remain immutable incomplete-campaign diagnostic
provenance. They are not promoted, pooled, or used as before/acceptance
evidence.

## T-M1-V2 tool/instruction targeted-pair preregistration revision 3

`A-M1-V2-TOOL-INSTRUCTION-SURFACE-20260812-03` supersedes only the active
measurement contract because canonical PR #142 is now exact
`bfa82b07590d3116ab10074977d168831255d784`. Attempt `-02`, its primary and
replacement roots, and replacement plan identity
`412b6fdad56329700c1d50956dde5d0686e35c914a58c7fcebe2165dd55edb96`
remain immutable failed ENOSPC diagnostic provenance. They are not changed,
renamed, revived, pooled, or promoted to acceptance.

This remains deterministic Task 3 evidence, not a statistical benchmark. It
requires exactly one eligible before and one eligible after observation for
each arm, ordered `current-web-cold`, `landing-cold`, `direct-warm`, then
`direct-cold`. Each accepted observation with no diagnostic gates the next.
The final 4x3 and statistical repetition remain solely owned by
`T-M1-V2-FINAL-BENCHMARK`; repeated same-policy/revision byte identity remains
separate real product selection and final serialization test evidence. All
existing reduction, final-body SC01, eligibility, cache, retry, route, source,
quality, safety, authority, native-executor, Work/Ledger/memory, build/reload,
desktop/mobile, and privacy criteria remain unchanged.

Before is the separate clean exact product checkout
`c46aae1af1b78a6f81ea40c3099edde0ba35ebd5`; after must be a separate clean
checkout at the fixed final product commit. Harness, fixtures, rubric, adapter,
evaluator, model `openai/gpt-5.6-sol`, reasoning `medium`, auth, and route are
pinned across each pair. The current partial product diff and test SHA-256
`b51a4460e60e5ba8c17550f37bfe5d0879dfe9949e92636bb21a7c37e6ef982c`
remain excluded from before and preserved until all four before arms pass.

One isolated replacement per arm remains allowed only for a typed
pre-render/pre-provider infrastructure failure with provider dispatch zero and
Session/providerRequests/observations all zero. The failed root and reason are
preserved. Provider error/retry, cache/route mismatch, identity, quality,
source, any model output, or any provider dispatch forbids replacement. The
same eligible infrastructure failure on the single replacement stops the
Attempt immediately as a separate driver blocker.

Every arm must pass the canonical disk, port, and bundled-resource preflight
before launch, with privacy-safe available/required byte evidence. No evidence
root, benchmark output, user file, or temporary file is deleted. Packaging is
forbidden at the currently observed approximately 9.23 GiB available because
the canonical packaged path requires 8.5 GiB. Only the existing canonical
prepared-resource option may be used, which requires 4.5 GiB and must reuse one
immutable resource for the entire before/after set after exact source
revision, size, archive digest, and launch validation are verified.

The renderer-ready repair smoke resource is present at its preserved smoke
root. It was produced from exact clean product `c46aae1a`, occupies 477,436 KiB,
contains a 213,866,608-byte archive whose SHA-256
`ce92403fe6897f511de41dec9f08da69c3797c826bcbc014972f145057d26b4f`
matches its release manifest, and its evidence records two clean
renderer/preload/App Gateway/native-runtime launches and zero provider
requests. Execution remains gated until the canonical benchmark consumer can
pass that prepared resource through its existing Electron-harness option; no
second driver, cache authority, test seam, or harness modification is allowed.

## T-M1-V2 tool/instruction targeted-pair preregistration revision 4

Attempt `A-M1-V2-TOOL-INSTRUCTION-SURFACE-20260812-03` is superseded before
measurement: no benchmark arm, provider dispatch, Session, or product
observation started under its `bfa82b07` contract. Its record is immutable and
is not reused. Attempt `A-M1-V2-TOOL-INSTRUCTION-SURFACE-20260812-04` pins the
new canonical PR #142 revision
`c3de3c9bd9bea673230c48b811b12dbc63aefb87`.

Revision 4 retains exactly one eligible before and after for each arm, in the
strict order `current-web-cold`, `landing-cold`, `direct-warm`, `direct-cold`.
Each accepted/no-diagnostics arm gates the next. The bounded zero-dispatch
infrastructure replacement policy and every reduction, identity, eligibility,
cache, retry, route, source, quality, safety, authority, native-executor,
Work/Ledger/memory, build/reload, desktop/mobile, and privacy condition remain
unchanged. Statistical repetition and final 4x3 remain exclusively Final
Benchmark authority.

Before remains clean exact `c46aae1af1b78a6f81ea40c3099edde0ba35ebd5`.
The prepared-resource public identity is pinned as source compatibility
`5a3077032c598d8aaa505b98b46c88f0236ade607086dca9a7fdfd1ebb564162`,
manifest `a67130bb07fdf85102e2f0ceb422e6dd4fd6d1f9797207caa594cc63dedd1b0b`,
dependency closure
`77710d83e4e6216381e9fa08c958cb562abb7ad64037479ca1bd3d1e6b082102`,
resource 274,983,193 bytes with identity
`34e8a634cc086813ccc33ab71d5f1c9fa6ceff550211ca03f3b0e337f1adc165`,
and archive 213,866,608 bytes with identity
`ce92403fe6897f511de41dec9f08da69c3797c826bcbc014972f145057d26b4f`.
Its runtime path is private local input only and is not persisted in this
report, the redacted plan, or public evidence. The canonical CLI pin option and
the existing production adapter composition are the only consumption route;
there is no packaging fallback.

## Attempt 4 unsuccessful before campaign

Attempt `A-M1-V2-TOOL-INSTRUCTION-SURFACE-20260812-04` stopped at the second
before arm under the preregistered sequential gate. `current-web-cold` was
accepted with no diagnostics at plan identity
`b9c224ccd9a4a565e10732d03074ed6ca2831c56600f079cec349c7467b23dad`:
5 Agent attempts, 271,016 provider-send bytes, 42,455 tool-schema bytes, 440
stable safety/role bytes, 48,495 stable BTCC protocol bytes, 5 semantic rounds,
7 scenario tool calls, 51,189 ms elapsed, no retries, one 1,620-byte auxiliary
attempt, one 684-byte title attempt, and accepted fixed-date, recommendation,
source-reference, source-grounding, workspace-authority, provider-route, DB
quick-check, and no-stall evidence. Usage was prompt 58,196, cache read 19,456,
output 1,292, and total 59,488 tokens; cache write remained unavailable.

`landing-cold` then rejected at plan identity
`2b968ceb009312125ecafa3502d2ee1f5aefbf4a5998ae28d01454b1557aa7d2`
with `physical_attempt_identity_join_failed` and
`landing_quality_or_visual_gate_failed`. It had 18 Agent attempts, 1,836,927
provider-send bytes, 175,554 tool-schema bytes, 1,584 stable safety/role bytes,
184,842 stable BTCC protocol bytes, 18 semantic rounds, 22 scenario tool calls,
321,213 ms elapsed, no retry-contaminated attempt, and one 844-byte title
attempt. Usage was prompt 338,770, cache read 172,544, output 11,593, and total
350,363 tokens; cache write remained unavailable. Build, desktop, mobile,
screenshots, responsive structure, Butler grounding, memory/context grounding,
workspace authority, provider routing, DB quick-check, Work reviews, and no
stall passed. The rendered landing evidence failed durable Project/Work,
tools/workspace authority, provider-routing, and recovery capability grounding;
the Project Ledger closeout was also not observed. These are descriptive
failed-before diagnostics, not a baseline or product regression comparison.

Because provider dispatch and model output occurred, replacement is forbidden.
No landing replacement, direct-warm, direct-cold, product implementation
continuation, after arm, Sol-high review, commit, push, PR, Windows workflow,
merge, default-on change, final 4x3, Hermes, OpenCode, or next Task was run.
The prepared resource identity stayed unchanged and its private runtime path was
not persisted. All earlier and current roots remain preserved diagnostic
provenance.

## T-M1-V2 tool/instruction product implementation closeout

The latest user authority moved the original provider/Electron before/after
campaign and all final quantitative/quality acceptance to
`T-M1-V2-FINAL-BENCHMARK`. Attempt
`A-M1-V2-TOOL-INSTRUCTION-SURFACE-20260812-05` therefore owns only the complete
product path and provider-free static/product integration evidence below. The
Attempt-04 observations above remain immutable diagnostic provenance; they are
not a baseline, paired evidence, or acceptance input.

### One real ingress-to-provider path

The production path is now:

`appRuntimePolicy -> snapshotTurnContext/prepare-turn ->
createProductionGuidedTurnAgent -> selectGuidedTurnPhasePolicy -> BTCC agent
loop -> ModelRoundRequest.tools -> modelFacingFunctionTools -> OpenAI response
request body`.

`selectGuidedTurnPhasePolicy` is the single BTCC-owned selection point. It
reads the admitted typed access/profile/tool authority once, projects the
existing `BUTLER_TOOLS` registry, produces one revisioned stable instruction
prefix (`butler.btcc-tool-instruction-policy.v1`), and supplies the actual
provider tool definitions. The flag
`BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE` remains default-off. Disabled selection
returns the prior canonical `visibleToolDefinitions` and `guidedInstructions`
bytes without running or merging a second path.

Enabled selection keeps registry identities for authorization and execution,
clones only the provider-facing schema projection, and removes runtime-owned
JSON Schema defaults from that projection. Direct turns contain no
Project/workspace/Work execution schemas; read-only project turns contain no
write/effect schemas. Structured exact required tools must survive the final
provider projection or dispatch fails closed. Required profiles are validated
against the authoritative profile/registry definitions: unknown or partially
eligible effectful profiles fail closed, while admitted non-effect MCP and
automation reads remain available. Writable App project and non-project
workspace authority is classified as execution without prompt keywords.

Project Ledger lifecycle capability remains in the authorized native catalog
and is progressively reached through `tool_search -> tool_describe ->
tool_call`; it still dispatches the canonical guided effect/native executor.
The flag-on source-to-result regression creates/reviews a Plan, discovers and
describes the lifecycle tools, creates and completes an actual Ledger Work,
records checkpoint/result/completion reviews, and verifies the Ledger Work and
durable Work completion result. That regression found and fixed one existing
bridge defect: `tool_describe` had redacted JSON Schema `const` values, causing
valid progressive calls to fail schema validation. `const` is now preserved,
while sensitive annotations and private paths remain redacted.

### Removed duplicate surface

The enabled stable prefix consolidates repeated role, tool-use, memory,
phase-safety, Work/Plan/Review/validation, and Ledger closeout guidance. The
dynamic response-language and persona/profile sections remain after the stable
prefix and retain their SC01 attribution. The legacy public
`tool-surface-controller`, selection, types, validation modules, their test,
the fixed-surface branch, and unused public character metric were deleted.
There is no second registry, keyword router, production test seam, hidden
retry/fallback, shell substitute, or permanent wrapper alias.

### Actual serializer byte arithmetic

The following provider-free arithmetic uses UTF-8 bytes of the real
`JSON.stringify(modelFacingFunctionTools(providerTools))` output plus the exact
selected stable prefix. Execution uses the actual App-shaped writable project
policy from `appRuntimePolicy` and `snapshotTurnContext`, not a synthetic empty
profile fixture.

| Phase | Tool schemas before -> after | Stable prefix before -> after | Combined reduction |
|---|---:|---:|---:|
| direct | 8,644 -> 5,386 | 9,454 -> 829 | 11,883 bytes (65.66%) |
| read-only project | 13,804 -> 8,499 | 10,020 -> 849 | 14,476 bytes (60.76%) |
| App-shaped execution | 19,743 -> 16,210 | 10,022 -> 1,279 | 12,276 bytes (41.24%) |

The same policy/revision test serializes byte-identical final schemas and
stable prefix across distinct Turn ids. These numbers are deterministic static
product evidence, not provider-send SC01 measurements and not the deferred
final E2E decision. They were rerun on the final reviewed diff through
`tests/unit/m1-v2-tool-instruction-surface.test.ts`; the execution fixture is
the real `appRuntimePolicy -> snapshotTurnContext` writable App project shape.

### Product validation and review

- broad focused policy, production agent-loop, App policy, native workspace,
  registry, and prompt suite: 396/396 passed with 3,551 assertions before the
  final review repairs; all affected tests were rerun after those repairs;
- final focused M1/production/progressive rerun: 90/90 passed with 491
  assertions;
- full typecheck passed;
- full lint passed with zero errors; changed-file ESLint passed with zero
  errors and zero warnings;
- BTCC source shape passed (`4 domains / 206 files`);
- architecture audit scanned 380 source files and reported 42 pre-existing
  size/index/generic-bucket review triggers; the new phase policy was not a
  trigger and no new module-direction violation was found;
- `git diff --check` passed and deleted public-surface references are absent;
- bounded repository-wide `bun run check` reached the 300-second limit and was
  terminated without a captured assertion failure, so it is not claimed as a
  pass;
- independent ordinary non-fast gpt-5.6-sol high whole-ingress review repaired
  the required-profile, real App phase, progressive lifecycle, and instruction
  source-to-result gaps, then returned `APPROVED` with no remaining P0-P3
  finding after independently rerunning the focused product path and final
  serializer arithmetic.

No provider request, Electron launch, prepared-resource run, benchmark arm,
final 4x3, Hermes, or OpenCode execution was performed after the latest user
authority prohibited them.

### Deferred final E2E acceptance

`T-M1-V2-FINAL-BENCHMARK` remains `todo` and exclusively owns the final
integrated provider/Electron campaign: exact final-body SC01 `tool_schema` and
stable-instruction reduction for all registered arms, provider-send bytes and
usage, cache/retry/route eligibility, request/tool/elapsed measurements, source
quality, Work/Ledger/memory overhead, restart/build/reload correctness, and zero
capability, authority, safety, native-executor, source, desktop, or mobile
quality regression. The feature remains default-off and this Task does not
merge or enable it.

### Delivery

The reviewed product implementation is commit
`320ba7f7d356ce7106ff07844cc0052483220daf` on
`feature/m1-v2-tool-instruction-surface`. Draft PR #148 is stacked on the exact
PR #146 product base and remains unmerged:
`https://github.com/Hexpy-Games/butler/pull/148`. Push-triggered Windows Package
workflow `31581272674` was cancelled and confirmed `completed/cancelled` under
the release-tag-only policy. The Project Ledger Task is `done`, product Attempt
`-05` is `succeeded`, the parent Work stays `in_progress`, the Plan stays
active, and the Final Benchmark Task stays `todo`. No next M1 optimization Task
was started.

## T-M1-V2 exact-first durable replay product implementation

The latest user authority moved Electron/provider smoke, prepared-resource and
affected-arm execution, the final 4x3, Hermes, and OpenCode acceptance to
`T-M1-V2-FINAL-BENCHMARK` without deleting any quantitative or quality target.
This Task therefore records product code, real production composition and
serializer integration, deterministic byte arithmetic, and non-E2E gates only.

### Ingress, authority, and final serialization

The one production path is:

`guided tool execution -> btcc_guided_tool_calls / btcc_guided_work_results ->
GuidedToolJournal delivery state -> BTCC agent-loop prepareMessages ->
ModelRoundRequest.messages -> provider-neutral serialization -> OpenAI/Codex
final request JSON`.

The existing guided tool journal remains the exact result-body and delivery
authority. Existing Work `result_ref`, `work_id`, result sequence, Session or
Project scope, and origin tool row remain the durable Work identity. The new
required `GuidedOperationResultReader` port is implemented by a SQLite reader
over those same rows; it is not a store, cache, reference registry, or effect
authority. Production composition injects the journal and reader explicitly.
If replay is enabled without either required capability, composition fails
closed instead of falling back to full legacy replay.

For a durable completed result whose stable JSON body is at least 8 KiB, the
journal advances `pending_delivery -> in_flight -> acknowledged ->
reference_only`. Raw content remains visible until the routed model round has
an accepted response. Retry/fallback attempts therefore retain the raw result;
only later model rounds receive the reference. SQLite close/reopen tests cover
all four states, same-round recovery, stale-round rejection, and accepted-route
checkpoint replay without provider redispatch or duplicate tool execution.

The model-facing carrier is `butler.operation-result-reference.v1` and contains
only bounded typed version/kind, direct-or-Work identity, tool name, SHA-256,
nullable direct or sequence revision, terminal success/availability semantics,
and the authorized exact-read capability. It contains no prompt, transcript,
raw tool payload, hidden reasoning, private path, or result body. Exact reads
are available only through the selected `read_operation_results` phase tool and
typed handler map. The SQLite reader verifies reference kind, Session/Project/
Work scope, revision, expected hash, and a fresh hash of the stored JSON; any
missing, stale, cross-scope, cross-kind, or tampered result fails closed. The
read contract returns an exact base64-encoded stored-JSON byte range with
offset, length, total bytes, next offset, completion, and hash metadata. A call
is capped at 4 KiB and invalid or out-of-range requests fail closed, so exact
rehydration is explicit and bounded rather than automatic whole-body loading.

Small completed results, failed or cancelled terminal results, and results with
no durable journal authority remain on the prior raw model-visible path so
their final meaning and recoverable error state are not discarded. No keyword
router, hidden string lookup, automatic hydration, duplicate effect/result
store, or new telemetry authority was added. The former repeated-raw area is
the acknowledged older tool-result projection, including Codex cumulative
`function_call_output` items; it is replaced in place by the same typed
reference. The prior default-off path remains byte-compatible when
`BUTLER_M1_V2_EXACT_ONCE_REPLAY` is absent.

### Exact serializer byte arithmetic

These static UTF-8 measurements call the actual Codex request serializer with
the already accepted M1 Tool Instruction Surface held constant. Each fixture
contains three cumulative outputs. Replay-off serializes the same 9 KiB raw
result three times; replay-on serializes it once and the deterministic reference
twice.

| Typed phase | Replay off -> replay on | Reduction |
|---|---:|---:|
| direct | 33,656 -> 17,237 | 16,419 bytes (48.78%) |
| read-only | 36,789 -> 20,370 | 16,419 bytes (44.63%) |
| execution | 44,932 -> 28,513 | 16,419 bytes (36.54%) |

These are serializer bytes, not provider-token usage, SC01 campaign results, or
E2E evidence. The same product integration also drives a production Guided
Turn through the real OpenAI model round and Codex serializer: the second
request contains the accepted large raw result and the third contains the
typed reference without that body.

### Validation and remaining boundary

- final targeted and production serializer integration: 107/107 passed with
  600 assertions;
- latest focused correction suite: 86/86 passed with 506 assertions;
- broad affected BTCC unit suite: 398/398 passed with 5,669 assertions;
- BTCC module-boundary suite: 6/6 passed; the combined BTCC/provider
  architecture rerun passed 9/9 with 3,540 assertions;
- full typecheck and `git diff --check` passed;
- full lint passed with zero errors and 19 pre-existing warnings;
- BTCC source shape passed (`4 domains / 215 files`);
- architecture shape audit found no new boundary violation; existing large-file
  and index review triggers remain outside this Task.
- independent ordinary non-fast gpt-5.6-sol high whole-goal review first found
  and drove closure of dynamic-Work, bounded-read, durable-acceptance,
  canonical-registry, official-serializer, and default-off discovery gaps; the
  final fresh review found no remaining issue and returned `APPROVE` after 92
  focused tests, typecheck, BTCC shape, module/provider boundaries, and diff
  verification.

This Task does not implement the whole user/assistant history cap, Turn
continuation budget, route/cache-prefix policy, Work-recovery optimization, or
read batching. Those remain separate bounded tasks. Final provider-token,
source-quality, cache/retry eligibility, desktop/mobile, and statistical 4x3
acceptance remain exclusively with `T-M1-V2-FINAL-BENCHMARK`.

### Exact replay delivery

The reviewed implementation is commit `fb1fee36658f5790c02c6e6966b91d2859ee175f`
on `feature/m1-v2-exact-first-durable-replay`. Draft PR #149 is stacked directly
on `feature/m1-v2-tool-instruction-surface` / PR #148 and remains unmerged:
`https://github.com/Hexpy-Games/butler/pull/149`. The first push-triggered
Windows Package workflow `31591320688` was immediately cancelled and confirmed
`completed/cancelled` under the release-tag-only policy. Project Ledger Task
`T-M1-V2-EXACT-ONCE-REPLAY` is `done`, Attempt
`A-M1-V2-EXACT-ONCE-REPLAY-20260812-01` is `succeeded`, the governing Work and
Plan remain active, and Final Benchmark remains todo. No next optimization Task
was started.

## T-M1-V2 Turn-owned bounded conversational continuation implementation

### Intent lock and bounded scope

The latest user authority narrows this Task to one product improvement atop the
accepted Tool Instruction Surface and Exact-first Durable Replay: bound the
model-facing user, assistant, and tool history and the Codex stateless carrier.
Electron/provider smoke, prepared resources, affected-arm campaigns, the final
4x3, Hermes, OpenCode, and route/cache-prefix reset policy remain forbidden in
this Task and unchanged for Final Benchmark or a later route-policy Task.

The one implemented ingress-to-serialization path is:

`Session binding and Turn preparation -> SQLite Turn admission/hydration ->
createProductionGuidedTurnAgent -> BTCC agent loop messages -> exact-result
projection -> bounded atomic model context -> ModelRoundRequest -> durable
model route retry/fallback -> runOpenAIModelRound -> official Responses or
Codex serializer -> final JSON body`.

Before this slice, the BTCC loop's in-memory `messages` array accumulated
user/assistant/tool history and OpenAI `runOpenAIModelRound` separately owned a
cumulative `previous.statelessInput + new items` Codex builder. The enabled
path now reconstructs Codex input solely from the Turn-admitted bounded model
context. Official Responses retains its bounded incremental
`previous_response_id` protocol. Route/cache-prefix reset policy is not changed.

### One durable Turn budget owner

`TurnContinuationBudgetState` schema
`butler.turn-continuation-budget.v2` is stored only in
`btcc_turns.continuation_budget_json`, admitted once with a fresh Turn, hydrated
by `SqliteGuidedTurnStateRepository`, and mutated by one fenced SQLite store.
Each compare-and-swap mutation requires the active Turn claim, revision, and
execution fence. Restart, provider retry, and route fallback cannot reset it.

The state contains only bounded counters, round ids, request digests, bytes,
finite policy, timestamps, and a terminal receipt. It stores no prompt,
transcript, tool body, hidden reasoning, credential, or private path.
`PromptUsageBudgetState` remains telemetry-only and was not made a controller.

The finite default-off selection validates every configured limit against a
hard ceiling. It owns cumulative distinct model requests, cumulative tool
rounds, per-request and cumulative model-facing prompt bytes, normalized
assistant text/function-call protocol output bytes, elapsed time, idle time,
and terminal exhaustion. Retry of an identical round is idempotent; a changed
digest for the same round fails closed. Output and tool accounting are likewise
round-idempotent.

Mandatory overflow and every exhausted safety ceiling atomically persist one
typed `turn_continuation_budget_exhausted` terminal receipt before the error is
surfaced. A hydrated terminal state rejects later dispatch admission without
another provider call. The flag
`BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT` is default-off; absent and explicit-off
production serializer bodies are byte-identical in the behavioral regression.
Flag-on Turn state without its transition dependency fails before dispatch.

### Atomic bounded carrier policy

The current request, stable safety/BTCC instructions, active phase tool surface,
current Work/authority material inside the request, incomplete tool protocols,
the newest tool/validation unit, and the newest active unit are mandatory.
Older eligible units are admitted newest-first and evicted oldest-first as
whole typed units. An assistant function-call item and all immediately
following tool results are never sliced or separated. Content is not
character-sliced or summarized, and there is no keyword router, model summary,
raw transcript clone, hidden retry, duplicate context store, or legacy fallback
on the enabled path. Exact-first durable result references remain unchanged and
are compacted before this carrier admission.

The OpenAI/Codex translation preserves first-user attachment input, assistant
text, function-call protocol, tool outputs, and request segment kinds. The
bounded carrier manifest replaces rather than appends the former cumulative
Codex manifest, so SC01 attribution still covers the final serialized body.

### Deterministic official serializer arithmetic

The static regression holds the accepted phase-minimal Tool Instruction Surface
and Exact-first Durable Replay enabled and changes only the 100-round
continuation carrier. It calls the actual `codexRequestBody` serializer and
measures exact `JSON.stringify` UTF-8 bytes.

| Typed phase | Unbounded history -> bounded continuation | Reduction |
|---|---:|---:|
| direct | 61,030 -> 11,629 | 49,401 bytes (80.95%) |
| read-only project | 64,163 -> 14,762 | 49,401 bytes (76.99%) |
| execution project | 72,306 -> 22,905 | 49,401 bytes (68.32%) |

These are deterministic static serializer bytes, not provider-send campaign
measurements, provider tokens, cache evidence, latency evidence, or E2E results.

### Product-path evidence and remaining boundary

The production integration uses `createProductionBtccComposition`, real Turn
admission/hydration, the production Guided agent loop, `runOpenAIModelRound`,
the Codex SSE adapter, and captures the final serialized fetch body across nine
model rounds. With an 18,000-byte provider-neutral admission ceiling, it retains
the exact current request and newest tool protocol, evicts the oldest eligible
call, and keeps every captured Codex body below 24,000 actual serialized bytes.
Separate tests prove 100-round deterministic bounded growth, atomic tool pairs,
mandatory overflow, cumulative prompt exhaustion, normalized output accounting,
SQLite nonterminal and terminal restart recovery, retry idempotency, route
fallback without full resurrection, attachment preservation, privacy, exact
replay compatibility, and flag-off rollback.

No Electron launch, provider request to a real service, prepared-resource run,
benchmark arm, final 4x3, Hermes, OpenCode, merge, push, or default-on change was
performed. Final provider-token, quality, cache/retry eligibility, desktop/mobile,
and quantitative M1 acceptance remain with `T-M1-V2-FINAL-BENCHMARK`. Route and
cache-prefix reset policy remains a separate Task. The governing Work and Plan
remain active.

Implementation validation completed without an external provider or E2E run:

- the broad affected suite passed 177/177 tests with 4,295 assertions across
  eleven BTCC, SQLite, route, serializer, image, attribution, and module-boundary
  files;
- after the final serializer-module and tool-integrity corrections, the bounded
  production-path regression passed 13/13 tests with 37 assertions, and full
  typecheck passed;
- full lint passed with zero errors and 19 pre-existing warnings, BTCC source
  shape passed (`4 domains / 220 files`), the architecture audit reported only
  the repository's existing review triggers, and `git diff --check` passed;
- the required bounded repository `bun run check` was allowed 300 seconds and
  ended at the explicit limit with exit 124 and no reported failure before the
  timeout. This is recorded as a timeout, not as a passing gate.

Independent gpt-5.6-sol high whole-goal review remains the Task completion gate;
the Task is not marked done here, and neither its governing Work nor Plan is
closed.

### Independent review correction phase

The first independent gpt-5.6-sol high review returned `CHANGES_REQUIRED` and
identified final-carrier defects that the initial internal suite did not expose.
The correction remains inside the same Turn-owned state and provider translation:

- official Responses no longer uses cumulative message counts against an
  evicted/reindexed bounded array. Minimal stable item identities determine the
  exact delta already represented by the `previous_response_id` chain, so each
  newly required tool output is delivered exactly once;
- an OpenAI route fallback that clears provider continuation now serializes the
  same full admitted bounded carrier rather than reverting to initial user input.
  A bounded fallback to another provider fails closed before its adapter because
  no non-OpenAI exact final-body admission integration is authorized in this Task;
- the existing Turn budget writer now admits the exact UTF-8 request serialized
  by the actual official Responses or Codex fetch boundary. Attachments and all
  provider carrier overhead are therefore included; oversized attachment input
  persists terminal exhaustion before fetch;
- normalized assistant output accounting excludes provider raw payload and
  `providerData`, while retaining visible assistant text and function-call
  protocol. Enabled continuations and accepted SQLite responses retain only the
  provider response id, finite sent/item identities, manifests, and normalized
  visible protocol—no cumulative stateless prompt/tool clone or provider data;
- bounded first-user attribution reapplies the composed prompt spans on every
  cumulative Codex rebuild, preserving current request, Work authority, memory,
  and source-reference kinds;
- `route_state_json` is the only persisted mutable route authority. Admission
  removes the duplicate embedded `modelSelection.modelRoute`, with production
  hydration/restart evidence reading the separate route state.

Failing-first behavioral tests captured the real defects: the third official
Responses body omitted `NEW-RESULT`, route fallback omitted latest protocol and
reference context, and a 10,000-byte limit admitted a tiny message projection
before a roughly 200 KiB attachment carrier could reach fetch. After correction,
the final body contains the newly required output exactly once, fallback retains
the admitted carrier without resurrecting old input, and the oversized carrier
records `model_facing_bytes` exhaustion with zero fetches. The correction broad
affected suite passes 171/171 tests with 4,295 assertions; focused typecheck also
passes. Final lint, shape, module, and diff gates are recorded with the correction
commit. Independent Sol-high rereview remains required before Task completion.

### Bounded identity and attachment correction

The next independent review found that attachment text could be composed twice
on the enabled path and that provider-continuation identities still depended on
content-derived hashes. The correction keeps one canonical attachment carrier:
the Guided prompt owns the typed attachment context while the OpenAI adapter
adds only image parts when that already-composed bounded prompt is present.
Multi-round Codex serialization now preserves the exhaustive Work, memory,
source-reference, and attachment segment spans without a duplicate text carrier.

Bounded continuation identity is now a Turn-local structural event identity,
assigned when BTCC appends each user or assistant observation and reused for the
corresponding provider response. It is neither transcript content nor an
unkeyed content digest, so repeated identical observations remain distinct.
The durable provider-private continuation is strictly limited to provider,
response id, and at most 256 validated bounded structural/protocol identities;
unknown private fields, raw transcript clones, malformed identities, and excess
cardinality fail closed. Current input is limited to 192 identities before
dispatch, reserving 64 response identities so a successful provider fetch cannot
create a post-fetch overflow. Function-call ids remain the protocol identity.

Behavioral regression evidence uses the actual API-key Responses serializer and
Codex serializer. It proves text plus function-call output is not duplicated,
new tool output is sent exactly once, repeated identical text events are not
deduplicated, an attachment prompt is not duplicated, and 193 current bounded
identities fail before fetch. A 100-round fixture keeps the private continuation
at no more than five identities and under 1,000 serialized bytes, with no prompt
content or 64-character unkeyed digest. The 11-file broad affected suite passes
182/182 tests with 1,318 assertions. These corrections do not change the
representative direct/read-only/execution byte arithmetic above: those fixtures
contain no attachments and Turn-local identity metadata is never serialized
into the provider body.
