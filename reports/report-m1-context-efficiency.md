# M1 context efficiency — benchmark authority unification

Date: 2026-08-12
Task: `T-M1-V2-BENCHMARK-HARNESS-UNIFICATION`
Governing spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Final paired campaign contract repair

Task: `T-M1-V2-PAIRED-CAMPAIGN-CONTRACT-20260813`

This bounded repair adds the final before/after campaign contract to the sole
PR #142 harness. It does not execute or complete
`T-M1-V2-FINAL-BENCHMARK`. The exact public-safe source pins are before
`c46aae1af1b78a6f81ea40c3099edde0ba35ebd5` and after
`394c98a97428b741f8ea54273a226cb062455ab0`; runtime checkout and resource
paths remain CLI-only and are redacted before manifest/checkpoint/report
persistence.

The canonical planner now supports one immutable paired mode with this exact
order for repetitions 1, 2, and 3:

`direct-cold before -> direct-cold after -> direct-warm before -> direct-warm
after -> current-web-cold before -> current-web-cold after -> landing-cold
before -> landing-cold after`.

That produces 12 adjacent blocks and 24 steps. Every step carries typed
version, fixture, repetition, block/order, pair, source revision,
source-compatibility, prepared-resource, and fixture identity. The same
planner, workflow, Butler adapter, evaluator, and report remain authoritative;
the earlier 12-step `m1-v2` mode is diagnostic only and does not become a
second final evaluator or report.

Provider authentication is a typed provider-free preflight input containing
only provider, auth mode, exact model, reasoning, execution mode, and
available/unavailable booleans. Unavailable auth/model stops before manifest
creation or dispatch as `measurement_unavailable`. Available execution is
preregistered as ordinary non-fast `openai/gpt-5.6-sol`, reasoning `medium`,
with actual request option `service_tier=default`. The provider-observation
adapter records only the returned service-tier scalar and exact model; missing,
fast/priority, model, reasoning, or provider drift rejects fail closed.

Before and after prepared resources have separate pins for source revision,
source compatibility, producer manifest, dependency closure, full resource,
archive, size, and mutation checks. Cross-version resource reuse and stale or
mutated sources fail closed. Replacement is permitted only for pre-provider
infrastructure failure; once provider dispatch or output begins, no replacement
is eligible.

Pair eligibility requires exact fixture, model, reasoning, ordinary execution
mode, provider, auth mode, route, and retry-free state with distinct before and
after sources. Cache mismatch is descriptive only; retry, route, model, source,
fixture, provider, auth, and execution-mode mismatches are rejected. Nullable
provider usage stays nullable. The paired aggregate reports per-arm and overall
absolute/ratio min, median, and max for provider-send bytes, physical requests,
model rounds, tool calls, elapsed, first useful, and usage; percentage deltas
are computed per pair rather than additively combined.

The acceptance projection retains the governing Spec revision 2 thresholds:
at least 30% exact provider-send reduction, 18-30% elapsed reduction target,
and zero quality regression. Landing quality separately requires durable
Project/Work and internal Ledger closeout, memory/context grounding,
tools/workspace authority, provider routing, recovery, build, reload, and
desktop/mobile checks. Historical Hermes, OpenCode, and rejected/provenance-only
Butler rows remain nullable and unranked in the pure provider-free comparison
index; no external agent was rerun.

No provider call, Electron run, prepared-resource build, renderer smoke,
campaign, Hermes, or OpenCode execution occurred in this repair. Final 4x3
statistics, quality acceptance, Work completion, default-on, merge, and
independent high review remain outside this Task.

Provider-free validation completed with the paired contract, immutable resume,
public workflow/checkpoint/report, pre-provider replacement, prepared-resource,
identity, and provider-observation suites passing. Typecheck, lint (zero errors;
20 pre-existing warnings), BTCC shape (`4 domains / 203 files`), module-shape
audit (only size-review signals), `git diff --check`, and repository-wide
`bun run check` passed. One broad parallel test invocation transiently exceeded
its existing five-second per-test timeout; the same test passed alone in 2.9
seconds and the later repository-wide check passed. No product or provider
execution was involved.

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

## Prepared-resource public consumer wiring correction

Task: `T-M1-V2-BENCHMARK-PREPARED-RESOURCE-CONSUMER-WIRING-20260812`

The canonical benchmark composition now accepts one explicit typed prepared
Butler resource reference and carries it through the existing single path:
CLI pin, path-free plan identity, `createProductionAgentAdapters`,
`createElectronButlerRunner`, and `runBtccR3ElectronHarness`. If the reference
is absent, the existing packaging path and 8.5 GiB preflight remain canonical.
If it is present, the harness verifies and uses only that resource with the
4.5 GiB prepared-resource preflight; any missing or unverifiable identity fails
closed as `measurement_unavailable` without packaging fallback or product
launch.

The preregistered public identity contains the build revision, exact packaging
input compatibility digest, producer manifest and dependency-closure digests,
mode-aware full resource digest and byte count, and archive digest and byte
count. The runtime-only directory is not included in the plan, evidence
diagnostic, observation, or this report. Verification requires the current arm
checkout revision, current packaging-input digest, producer-owned full release
manifest and dependency closure, current host artifact/launcher platform, and
the archive and complete resource identity. It rejects symlinks, special file
types, permission-mode changes, closure or manifest forgery, and mutation
during each harness call. Cross-revision reuse is allowed only when the exact
packaging-input digest is unchanged; any source-affecting change requires a new
build and pin.

The existing artifact format has no producer-owned cryptographic Git-revision
receipt, so `sourceRevision` remains an explicit preregistered build-provenance
claim rather than an invented receipt. The current checkout revision,
packaging inputs, producer manifest and closure, archive, and full resource are
independently and cryptographically verified. The accepted prepared artifact
identity is:

- build revision `c46aae1af1b78a6f81ea40c3099edde0ba35ebd5`
- source compatibility
  `5a3077032c598d8aaa505b98b46c88f0236ade607086dca9a7fdfd1ebb564162`
- manifest `a67130bb07fdf85102e2f0ceb422e6dd4fd6d1f9797207caa594cc63dedd1b0b`
- dependency closure
  `77710d83e4e6216381e9fa08c958cb562abb7ad64037479ca1bd3d1e6b082102`
- resource: 274,983,193 bytes,
  `34e8a634cc086813ccc33ab71d5f1c9fa6ceff550211ca03f3b0e337f1adc165`
- archive: 213,866,608 bytes,
  `ce92403fe6897f511de41dec9f08da69c3797c826bcbc014972f145057d26b4f`

Acceptance evidence:

- Failing-first production composition proved that the prepared pin was not
  previously consumed. A second failing-first live check proved that a
  successful renderer launch smoke was incorrectly passed to the turn-only M1
  collector. Both gaps were repaired in the same public adapter and runner.
- One provider-free current-web public adapter smoke performed two sequential
  Electron renderer-ready launches, restart persistence, and normal cleanup.
  Both Electron and executor processes stopped, `providerRequests` and Step
  observations remained empty, and the full resource identity was identical
  before and after the call.
- Valid, absent, missing, source, compatibility, manifest, closure, archive,
  size, hash, host-platform, mode, special-file, post-consumption mutation,
  path privacy, sequential reuse, CLI handoff, and resume-identity cases are
  regression-covered. Existing current-web, direct-warm, identity, temporal,
  disk, port, and renderer-readiness coverage remains green.
- Targeted prepared-resource validation passed 31 tests. Typecheck and lint
  passed; module-shape and direction review found no new issue;
  `git diff --check` passed. Independent ordinary non-fast Sol-high review
  approved the fixed public path with no remaining P0-P3 findings.

No provider token, campaign, final 4x3, Hermes/OpenCode run, product policy
change, retry, fallback, second adapter/runner, merge, or default-on change was
used. Existing diagnostic roots and prepared resources remain preserved.

## Canonical landing evidence acceptance diagnosis

Task: `T-M1-V2-BENCHMARK-LANDING-EVIDENCE-ACCEPTANCE-20260812`

The preserved Attempt -04 `landing-cold` observation was inspected without a
replacement or provider rerun. Its target membership contained 18 exact Agent
requests and one exact title request under one product-owned Session and Turn.
Every request matched its typed ordinal, role, attempt digest, serialized byte
count, and terminal observation. The 18 Agent request bytes also matched the 18
arm-tagged SC01 envelopes exactly. The remaining 844-byte title request was an
unarmed physical-overhead request, but the evaluator incorrectly required every
unused typed target identity, including non-Agent identities, to own an SC01
envelope. That caused `physical_attempt_identity_join_failed` even though Agent
membership and attribution were complete.

The physical join now requires SC01 envelope consumption only for target Agent
identities. Complete typed title, auxiliary, and provider-tool identities remain
observable overhead without becoming semantic Agent attempts. Missing,
duplicate, conflicting, wrong-Session/Turn/role/digest/byte/time/arm Agent
identity, duplicate envelope, retry ambiguity, and an arm-tagged non-Agent
envelope still fail closed. A failing-first public evaluator regression using
the observed 18-Agent-plus-title shape failed on the old code and passes after
the one-condition repair while retaining the landing quality rejection.

A separate observation-fidelity defect was also proven. The canonical adapter
copied generated files only for the legacy `butler_landing_page` fixture id, so
the typed M1 `landing-cold` workspace was semantically validated but its actual
HTML, CSS, and package file were not copied to the arm output before runtime
cleanup. The public result consequently reported zero changed paths despite
successful file mutation and rendering. The existing copy path now admits only
the legacy landing fixture or the typed M1 `landing-cold` arm. Existing
containment checks and exclusions for repository input, dependencies, build
outputs, caches, and coverage remain unchanged; non-landing fixtures still do
not copy artifacts.

The quality rejection is genuine, not an extractor miss. The preserved rendered
page visibly explains memory/context, planning, tool use, and result execution,
but it does not explain durable Project/Work, workspace authority, provider
routing, or failure/restart recovery. Those four capability claims are absent
from the actual result, while memory/context is present and passed. Revision 2
explicitly requires a landing page to explain these Butler-specific
capabilities, so no fixture, regex, threshold, or quality rubric was weakened.
Project Ledger closeout is tracked separately as internal Work evidence; its
absence did not create the landing quality reason and was not converted into a
required page claim.

No generated product artifact, clean product source, fixture, quality rubric,
provider result, or preserved root was modified or promoted. No replacement,
campaign, final 4x3, Hermes/OpenCode run, hidden retry, product optimization,
merge, or default-on change occurred. The landing observation remains
quality-ineligible after the harness repairs, so the paused product Task is not
resume-authorized by this diagnosis.

Validation passed 89 focused and public-path tests, typecheck, lint with zero
errors and 20 pre-existing warnings, BTCC shape, module-boundary review, and
`git diff --check`. The repository-wide check reached the broad unit phase with
no observed assertion failure but hit its bounded 301-second timeout, so a full
repository-wide pass is not claimed. Independent ordinary non-fast Sol-high
review traced both source paths and the preserved evidence, then approved with
no actionable P0-P3 findings.
