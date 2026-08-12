# M1 context efficiency — benchmark authority unification

Date: 2026-08-12
Task: `T-M1-V2-BENCHMARK-HARNESS-UNIFICATION`
Governing spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Status

PR #142 and `tests/support/agent-benchmark` are the sole benchmark
implementation authority. This branch contains no parallel executable M1
baseline domain. The final M1 benchmark remains todo; no final 4x3 campaign or
external Hermes/OpenCode execution occurred during this consolidation.

## Single call path

`benchmark:agents` -> `createBenchmarkPlan` -> `runAgentBenchmark` ->
`runBenchmarkArm` -> Butler adapter -> existing BTCC Electron harness/driver ->
`evaluateAdapterResult` -> `summarizeBenchmarkResult` / `writeBenchmarkReport`.

M1 v2 is a campaign mode of that path, not a second runner. The planner emits
the four exact Butler arms with three preregistered repetitions, stable fixture
hashes, one source revision, sequential isolated roots, and one policy object.
The same workflow persists `manifest.json` and `result.json`. Each Butler arm
uses the existing Electron/App/Session Actor/BTCC/provider execution primitive.

The Sol-high review found and the implementation closed two source/persistence
authority defects. M1 validation and preflight now use the exact plan SHA while
the historical cross-agent pilot remains pinned to its comparison baseline.
The CLI reports that plan SHA rather than the historical constant. A run-root
manifest is create-only and permits only an identical resume; seed, source,
fixture, or plan-identity mismatch fails before execution. Checkpoint persistence
rejects corrupt/different plans and preserves already-terminal evidence rather
than initializing or overwriting a replacement result.

A second Sol-high review then exposed two remaining authority gaps. The planner
and arm workflow now read fixtures only from the explicit PR #142 harness root;
the clean product source root is used solely for evaluated repository and SHA
evidence, so an exact PR #146 checkout does not need benchmark files. Planning
also invokes the canonical JSONL verifier and freezes metadata, JSONL, and
verified-evidence digests in the plan/manifest identity. The same workflow
reverifies that authority before fresh or resumed execution, and provenance
mutation fails before preflight or checkpoint replacement.

## Integrated ownership

- `fixtures.ts` is the public fixture authority; `fixtures/m1-v2` stores the
  exact direct-cold, direct-warm, current-web-cold, and landing-cold JSON plus
  JSONL provenance metadata.
- `planning.ts` is the sole planner for comparison and M1 modes.
- `workflow.ts` and `workflow-arm.ts` are the sole orchestration loop. M1 mode
  preflights and runs Butler only; Hermes/OpenCode remain adapter contracts.
- `evaluators.ts` is the sole public evaluation entry. Internal M1 policies
  check additive bytes, cache/retry/route/source eligibility, nullable usage,
  physical request identity, Work/Ledger safety, database integrity, dated web
  evidence, and Butler-specific landing quality.
- `report.ts` owns the one public report summary. Its M1 section reports
  nullable usage, retry contamination, segment mix including Work/Ledger and
  memory cost, unarmed physical overhead, quality, timing, and stability.
- `butler-adapter.ts` observes the real product evidence. It does not move
  product routing, retry, cache, Work, or completion policy into test support.

## Fixture and rubric provenance

The checked-in prompts and landing starters are byte-identical to the four
authoritative JSONL tool calls recorded in
`fixtures/m1-v2/provenance.json`. Original `low` reasoning is provenance only;
canonical M1 execution is ordinary non-fast `openai/gpt-5.6-sol` at `medium`.
Direct-warm keeps warmup and target in the same Session with an exact expected
and observed cache-boundary revision. The web rubric requires the fixed
2026-08-10 date, an umbrella recommendation, public URLs, web-tool evidence,
and nonzero source-reference bytes. Landing evaluation requires changed
starter files, build, reload, desktop/mobile overflow checks and screenshots,
Butler-grounded durable Work, memory/context, workspace authority, provider
routing, recovery, feature blocks, a use scene, CTA, and responsive CSS.

## Historical evidence

The PR #142 compact 12 observations remain rejected and unranked. The PR #146
campaign artifacts remain immutable provenance only; their old labels do not
satisfy the corrected frozen rubric or final M1 acceptance. No observation was
rerun, replaced, fabricated, re-ranked, or promoted during unification.

## Branch relationship

PR #142 owns all benchmark fixtures, planning, execution composition,
eligibility, evaluation, and reporting. PR #146 owns production SC01 request
segment/envelope/nullable usage attribution and the smallest authenticated
smoke wiring. PR #147 remains a stacked audit record and is not modified by
this branch. Final branch cleanup and dual-branch Sol-high approval are Task
closeout requirements outside this branch-local implementation report.

## Remaining acceptance boundary

This Task does not mark `T-M1-V2-FINAL-BENCHMARK` done. That later Task alone
may run the final controlled four-by-three and decide the quantitative M1
criteria. The next optimization Task must use this harness for preregistered
affected-arm pairs without running the full matrix.

## P1 repair validation

- Actual M1 workflow/preflight accepts a clean checkout at its exact plan SHA
  and gates a checkout mismatch; current main and PR #146 exact SHAs are valid
  M1 planning authorities.
- Actual workflow arm fixture loading succeeds with PR #142 as harness authority
  and a clean independent PR #146 product checkout that has no benchmark fixture
  tree; the product checkout is never used as fixture authority.
- The plan/manifest identity includes canonical verified provenance digests.
  Mutating the authority after manifest creation makes both same-plan workflow
  resume and CLI re-entry fail closed before product execution.
- CLI preflight result output reports the exact M1 source revision.
- Identical CLI resume preserves byte-identical `manifest.json`, its original
  creation identity, the result plan identity, and terminal evidence.
- Seed, source revision, fixture content, arm source revision, corrupt manifest,
  checkpoint plan, and terminal evidence replacement all fail closed.
- No product/provider execution, Hermes/OpenCode execution, or final 4x3 was
  performed for these tests.
- Targeted harness/adapter/driver tests: 89 passed, 0 failed, 470 assertions.
- Typecheck passed; lint passed with zero errors and 20 unrelated existing
  warnings; BTCC shape passed (`4 domains / 203 files`); agent-benchmark module
  audit passed (`44 files / 0 findings`); `git diff --check` passed.
- Repository-wide `bun run check` is not claimed as pass: the bounded 300-second
  run exited `124` after SIGTERM without emitting a specific assertion failure.

## Benchmark harness identity and physical join repair

Task: `T-M1-V2-BENCHMARK-HARNESS-IDENTITY-REPAIR-20260812`

The canonical PR #142 harness now carries the actual Electron product-owned
Session, Turn, request ordinal, request role, and physical attempt digest from
the existing driver into the single M1 evaluator. The evaluator no longer
reconstructs an expected Session id from the benchmark arm key. It requires the
target observation Session to equal the evidence Session and retains the
existing exact run-root, source revision, prompt hash, and stale-evidence gates.

Physical request joining is role-aware and fail closed. Only target-owned Agent
requests can join an arm-tagged request envelope, using exact ordinal, attempt
digest, serialized bytes, terminal-time tolerance, and arm identity. Typed
title, auxiliary, and provider-tool requests remain visible as separate
physical overhead and are excluded only when their envelope is unarmed. A
non-Agent envelope carrying the target arm, or an Agent request with missing or
wrong Session, Turn, ordinal, digest, byte, time, or arm identity, rejects the
repetition. Real physical retries remain separate exact joins.

This repair preserves the one fixture, planner, driver, evaluator, and report
authority; exact segment byte sums; nullable provider usage; retry/cache/route
eligibility; privacy-safe metrics; and sequential isolated execution. It adds
no product feature path, fallback, retry, raw content storage, runtime policy,
or default-on behavior.

Validation evidence:

- The observed clean Electron identity shape
  `chat-btcc-r3-e2e-agent-benchmark-*` is accepted through the real driver
  identity operation and evaluator entrypoint.
- Stale evidence and wrong Session, Turn, or attempt identity remain rejected.
- Late typed title/auxiliary/provider-tool requests do not contaminate the Agent
  join, while an arm-tagged non-Agent envelope rejects fail closed.
- Multi-attempt retry joining, exact byte sums, SC01 typed segments, and
  unavailable usage as `null` are regression-covered.
- Targeted driver/proxy/evaluator/authority suites passed 101 tests with 498
  assertions; typecheck passed; lint passed with zero errors and 20 unrelated
  existing warnings; BTCC shape and repository-wide `bun run check` passed;
  module-shape review found no new responsibility or direction defect; and
  `git diff --check` passed.
- Independent ordinary non-fast Sol-high review initially requested two
  changes: reject arm-tagged non-Agent envelopes and connect identity cases
  through the real driver operation to the evaluator. Both were repaired; the
  same reviewer then approved with no remaining P0-P3 findings.

No external provider smoke, benchmark campaign, final 4x3, Hermes/OpenCode run,
product optimization, merge, or default-on change was performed. The earlier
diagnostic repetitions remain rejected provenance and are not promoted to an
accepted baseline. A later approved bounded product smoke may verify real
provider late-arrival timing, but no external campaign is required or claimed
by this repair Task.

## Benchmark target-membership temporal join correction

Task: `T-M1-V2-BENCHMARK-HARNESS-TEMPORAL-JOIN-CORRECTION-20260812`

The completed identity repair left one temporal edge: interval metrics retained
a prior-Step title envelope that started before target submission but terminated
during the target window, while the request snapshot had previously filtered
that request by start time. The unmatched prior envelope then rejected an
otherwise valid direct-warm repetition.

The physical join now starts exclusively from the target Step's typed
`providerRequestIdentities`. Request and envelope time bounds corroborate an
exact ordinal, role, digest, serialized-byte, terminal-time, and arm join; they
do not infer ownership. A prior unarmed title envelope that overlaps the target
interval is therefore not attached to the target Agent attempt and cannot
reject it. Its typed bytes remain explicit repetition and campaign overhead.
Missing requests or envelopes, duplicate or conflicting ordinal/digest/role,
arm-tagged non-Agent requests, ambiguous ownership, and stale or wrong Session
or Turn identity still reject fail closed. Exact Agent retry joins remain
separate and complete.

The regression follows the real in-repository operation path from
`runScenarioStep` through `providerRequestTurnIdentities`, Electron evidence,
the adapter evaluator, and `summarizePhysicalRequests`. It covers the observed
start-before/end-during case plus end-before, start-during, target auxiliary and
title requests, Agent retries, missing membership observations, duplicate and
conflicting identities, and byte/time/arm corroboration failures.

Validation evidence:

- The broad driver/proxy/evaluator/authority target passed 108 tests with 512
  assertions; the focused identity suite passed 17 tests.
- Typecheck and BTCC shape passed; lint passed with zero errors and 20 unrelated
  existing warnings; module audit exited zero with only existing size-review
  signals; and `git diff --check` passed.
- Repository-wide `bun run check` reached the full unit phase without an
  observed assertion failure but exceeded its bounded 300-second validation
  window, so a complete repository-wide pass is not claimed.
- Independent ordinary non-fast Sol-high review approved the fixed diff with no
  remaining P0-P3 findings.

No external provider smoke or benchmark campaign was needed for this
deterministic selection contract. No final 4x3, Hermes/OpenCode run, product
runtime change, merge, or default-on change was performed. The clean-campaign
observations that exposed the gap remain diagnostic provenance only and are not
promoted to a baseline.

## Current-web renderer-ready resource repair

Task: `T-M1-V2-BENCHMARK-CURRENT-WEB-RENDERER-READY-REPAIR-20260812`

The preserved primary and replacement failures are diagnostic provenance, not
benchmark acceptance. Their zero Agent attempts, provider requests, and product
observations are consistent with the earlier complete run evidence: Electron's
bundled Agent extraction failed with `ENOSPC`, the App fatal-startup path exited
cleanly with code 0 before renderer readiness, and the harness consequently
reported only a generic pre-render failure. The proven call path is
`prepareElectronRun -> prepareBundledAgentResource -> createServiceReleasePackage`
followed by Electron
`prepareAppManagedAgentRuntime -> extractAgentArchive -> extractPosixAgentArchive`.
No defect was found in the separately pinned product policy.

The harness now fails closed before packaging or product launch when the actual
write-owner filesystems cannot satisfy their bounded archive lifecycle peaks.
It distinguishes disk exhaustion from capacity-inspection failure, preserves
typed stage/cause/owner/exit-code/signal evidence, and applies the same typed
contract to port conflicts and renderer clean/nonzero/signal/timeout exits.
Only allowlisted resource fields cross the evidence boundary; benchmark
diagnostics retain no paths, raw payloads, prompts, or credentials. The existing
adapter consumes recovered prelaunch evidence as `measurement_unavailable` with
nullable metrics. There is no retry, restart, sleep, timeout extension, second
driver, or product runtime-policy copy.

Validation evidence:

- The actual Electron runner, Butler adapter, and evaluator integration recovers
  a preparation failure as a gated unavailable measurement.
- Bounded localhost CDP tests cover renderer ready and an actual early clean
  exit; policy regressions cover nonzero exit, signal, and readiness timeout.
- Disk capacity, filesystem inspection, same/different device lifecycle peaks,
  App/debug port conflicts, evidence privacy, provider observation, product
  ownership, identity, temporal join, direct-warm, and run-authority regressions
  passed in the focused suite.
- A provider-free local launch smoke against the exact clean product revision
  reached renderer, preload bridge, App Gateway, and native runtime readiness,
  recorded zero provider requests, and cleaned both launches normally.
- Typecheck, lint with zero errors, BTCC/module-shape checks, and
  `git diff --check` passed. Module review reported only pre-existing large-file
  review signals and no new boundary or direction defect.
- Repository-wide `bun run check` emitted no specific failure but did not finish
  within the bounded 300-second window, so a repo-wide pass is not claimed.
- Independent ordinary non-fast Sol-high review found lifecycle-accounting,
  consumer-wiring, privacy, and compile issues over three review cycles. Every
  finding was repaired; final approval is recorded only after the fixed-diff
  re-review.

No provider campaign, final 4x3, Hermes/OpenCode run, product optimization,
merge, or default-on change was performed. The preserved failures remain
unavailable measurements and were not cleaned, renamed, or promoted.
