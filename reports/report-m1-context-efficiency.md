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
with request execution mode `auto_by_omission`; the frozen serializer omits
`service_tier` and the proxy does not mutate its bytes. The provider-observation
adapter separately records the effective response tier and exact model. Only a
reported effective `default` Agent attempt is ordinary non-fast eligible;
missing, fast/priority, model, reasoning, or provider drift is durably typed and
rejected fail closed without replacement.

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

## SC01 durable evidence export repair

Task `T-M1-V2-SC01-DURABLE-EVIDENCE-EXPORT-REPAIR-20260813` adds one
privacy-safe immutable projection before per-arm Electron `dataRoot` cleanup.
The existing provider observation now records only an observer-private random-
key HMAC-SHA-256 and a bounded serializer contract for the exact unchanged final
Buffer sent upstream; the key is not retained. An absent service-tier field is
typed `auto_by_omission` without mutating bytes, and only provider-reported
effective `default` attempts are ordinary-non-fast eligible.
The exporter joins every arm-tagged SC01 envelope/segment/nullable-usage row to
exact all-Step Session/Turn/ordinal/role membership, preserving target and
other-Step Agent attempts while evaluator arithmetic consumes target attempts
only. It verifies exact segment sum, envelope/provider byte equality, route/
serializer identity, retry identity, and typed non-Agent overhead.

Publication is create-only and durable: exclusive temporary write, file sync,
atomic hard-link publication, temporary unlink, directory sync, reopen, schema/
identity/count/hash verification, then cleanup. An export or verification
failure returns `measurement_unavailable`, keeps `dataRoot`, and supplies no
post-dispatch replacement. Identical resume verifies idempotently; temporary,
stale, conflicting, or mutated evidence fails closed. The evaluator reopens the
export and reconstructs only operational metric rows from the verified public
projection before calculating SC01 results. No raw request body, prompt,
transcript, message, tool payload, response body, credential, private path, or
hidden reasoning is retained.

A valid export orphaned before checkpoint terminalization is retained as
`measurement_unavailable` with `provider_dispatched` state. Repeated resume
reverifies the same handle/hash and cannot authorize adapter/provider dispatch.
Report generation likewise gates post-dispatch M1 summaries whose durable
handle is absent or whose export no longer verifies.

Provider-free focused validation passed the durable exporter/cleanup suite and
provider observation proxy suite. No provider, Electron, prepared resource,
renderer, campaign, Hermes, or OpenCode execution occurred. Final 4x3 results,
the immutable failed Attempt `A-M1-V2-FINAL-BENCHMARK-20260813-01`, and its
manifest were not changed or reconstructed.

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

## Second paired contract review repair

Task: `T-M1-V2-PAIRED-CAMPAIGN-REVIEW-REPAIR-2-20260813`

The second Sol-high review found that the prior closeout was premature. The
contract now freezes and validates the exact managed-auth ordinary execution,
all prepared-resource fields and their paired digest, complete provenance,
replacement policy, acceptance policy, and the Spec revision 2 registered
request hypothesis: exactly 45 baseline physical requests must become 38–40.
Rehashed priority-tier, auth, policy, request-gate, prepared-pin, and provenance
forgeries fail closed.

Authentication no longer uses a proxy echo. The public workflow consumes a
redacted Butler-owned auth-status/model-catalog receipt with observed
`codex_oauth`, selected provider/model callability, and the public managed auth
contract. Missing or uncallable receipt evidence stops as
`measurement_unavailable`; a bearer header alone cannot establish auth mode.
Pairing identity is formed from observed request-envelope/Agent-attempt fields
for cache eligibility, route, provider, model, reasoning, auth, execution mode,
retry, source, and fixture rather than reconstructing them from the Plan.

Execution-identity rejection now has precedence over an otherwise accepted M1
summary. The aggregate additionally requires every one of the 24 observations
to remain terminally accepted and quality-accepted. Landing requires all five
approved content claims, separate internal Ledger closeout, build/reload,
desktop/mobile screenshots, SQLite integrity, zero duplicate effects,
corrections or anchor loss, workspace and provider-route authority, and no
Work stall. Any rejected row keeps the comparison index unranked.

A provider-free integration invokes the exported CLI composition and parser,
creates the immutable Plan, runs all 24 arms through an available fake adapter
with complete typed M1 evidence, then exercises evaluator, report, JSON index,
and HTML index. It proves both accepted/ranked and service-tier-drift
rejected/unranked outcomes without Electron or a provider call.

The governing Plan says Windows CI is release-tag-only, but the latest explicit
user operational instruction requires cancelling the unavoidable PR-triggered
run after every push. That later instruction governs this delivery: the exact
SHA run is cancelled immediately before build and verified
`completed/cancelled`. This does not claim the older release-tag-only condition
was achieved and does not modify the workflow.

## Final paired campaign contract review repair

Task: `T-M1-V2-PAIRED-CAMPAIGN-REVIEW-REPAIR-20260813`

The canonical PR #142 provider-free harness now validates the full regenerated
24-step `4 arms × 3 repetitions × before/after` array, including source,
prepared-resource, fixture, provenance, pair, block, and order identities. The
runtime-only roots remain outside the immutable public manifest and evidence.
Paired planning requires an explicit durable non-temporary run root and rejects
overlapping run, harness, source, or prepared-resource roots.

The preregistered `openai/gpt-5.6-sol`, medium reasoning,
`ordinary_non_fast`, provider, auth mode, and `auto_by_omission` request contract
is carried through the actual harness request identity and corroborated against
each target request and response. Only provider-reported effective `default`
is eligible; missing or conflicting model, reasoning, auth, or response tier is
durably rejected. No credential value is
retained; only the typed auth mode and authorization scheme are recorded.

Pair eligibility is one typed evaluator decision used by the aggregate and
report. Cache mismatch is descriptive only; fixture, model, reasoning,
execution mode, provider, auth, route, retry, or invalid source pairing is
rejected. Durable dispatch state allows at most one replacement only for a
typed pre-adapter infrastructure gate. Adapter entry, provider dispatch,
provider output, consumption, and verification failures cannot be replaced.

The paired report includes exact provider-send bytes, all physical provider
requests (agent, auxiliary, title, and provider-tool), model rounds, tool calls,
nullable elapsed and first-useful latency, every nullable usage field, and the
full segment taxonomy. Per-arm and overall before/after/delta/ratio outputs use
min, median, max, and range with exact 3-pair-per-arm and 12-pair completeness.
Acceptance requires completeness, at least 30% provider-send reduction, a
physical-request reduction, the 18–30% elapsed target, and zero quality
regression. Empty or incomplete input fails closed and nullable values are not
coerced to zero.

The same report path writes immutable provider-free JSON and HTML comparison
indexes. Frozen Hermes, OpenCode, and historical Butler entries remain
unranked; the paired Butler result becomes ranked only when the complete final
acceptance verdict passes. This work did not run a provider, Electron,
prepared-resource build, renderer, campaign, Hermes, or OpenCode, and it did
not change product M1 code. The final benchmark Task remains todo/blocked and
the governing Work remains in progress.

## Third paired contract review repair

Task: `T-M1-V2-PAIRED-CAMPAIGN-REVIEW-REPAIR-3-20260813`

The third Sol-high review found that the repair-2 closeout was still premature.
The paired workflow no longer accepts a caller-authored receipt file or
benchmark-only envelope fields. Before manifest creation it now invokes the
existing privacy-safe `butler auth status --json` and `butler model list --json`
surfaces through one injectable command executor. Only a strict allowlist is
projected into the receipt; missing commands, invalid output, unavailable
managed OAuth, or an unavailable exact model stop as
`measurement_unavailable` before preregistration or dispatch. Unknown secret
or private-path fields from CLI output cannot enter the manifest, result,
Markdown report, JSON index, or HTML index.

Frozen request-envelope authority is limited to the actual fields shared by
the before and after revisions: provider id, model ref, source revision, cache
boundary revision, retry ordinal, and eligibility. Reasoning and request/response
tier come from the provider observation proxy, auth mode from the Butler CLI
preflight, route from the actual upstream request route, and fixture membership
from the immutable Step. Fake-only envelope reasoning, route, auth, execution,
and fixture fields were removed. Either-side cache mismatch is descriptive;
any other ineligible observation, retry, route, auth, provider, model, source,
or execution drift is rejected.

The freshly verified top-level provenance identity must deep-equal the paired
contract provenance before planning. Rehashed caller provenance is rejected.
Before aggregation and ranking, results must contain exactly the 24 Plan arms
once, in exact order, with matching public arm identity. Resume permits only a
unique exact prefix and rejects skipped, duplicated, reordered, or mutated arm
identity. A 25-row duplicate remains incomplete and unranked.

Provider-free public CLI integration covers both exact frozen source revisions,
the actual envelope shape, available and unavailable auth/model command output,
all 24 accepted observations, service-tier rejection, privacy redaction,
report/index ranking, duplicate unranking, and checkpoint resume rejection.
No provider, Electron, prepared-resource build, renderer, campaign, Hermes, or
OpenCode execution was performed. The final benchmark remains todo/blocked and
the governing Work remains in progress.

The governing Plan's older release-tag-only Windows rule remains in conflict
with the latest explicit user instruction. The later operational instruction
governs: the unavoidable exact-SHA PR run is cancelled immediately and verified
`completed/cancelled`; release-tag-only behavior is not claimed and the workflow
is not modified.

Validation passed 32 focused tests, the broad provider-free benchmark and
prepared-resource set (137 tests before the route expectation update), and the
updated provider observation proxy set (15 tests). Typecheck, full lint with
zero errors and pre-existing warnings, BTCC shape, module audit, and
`git diff --check` passed. The bounded repository check reached the broad unit
phase without a product assertion failure attributable to this change, then hit
its 303-second limit; its interrupted auth-status subprocess reported a null
status. That exact auth-status test passed independently immediately afterward.
A full unbounded repository pass is therefore not claimed.

## Fourth paired contract review repair

Task: `T-M1-V2-PAIRED-CAMPAIGN-REVIEW-REPAIR-4-20260813`

The fourth Sol-high review found that repair-3 still depended on a basename
spawn with an empty environment, normalized only one managed auth shape,
treated the raw Codex transport provider as the canonical family, and rejected
the frozen `usage_unavailable` eligibility. The repair-3 closeout was corrected
through Project Ledger CLI and this final bounded repair owns those findings.

The public paired CLI now resolves `butler` through the existing executable
resolver and executes its absolute path with the repository safe environment.
Only privacy-safe PATH, HOME, BUTLER_DATA, and the existing allowlisted runtime
keys propagate; arbitrary secret variables do not. A real provider-free Butler
subprocess regression invokes `butler auth status --json` and
`butler model list --json` through the public paired CLI. It exercises the
actual bundled model catalog and a temporary local managed profile without a
provider request.

Both product-owned managed auth shapes normalize to the public `managed`
contract while preserving their raw evidence: `codex_oauth` must pair exactly
with `CODEX_AUTH_JSON`, and `codex_subscription` exactly with
`BUTLER_CODEX_AUTH_PROFILE`. Cross-paired source/mode evidence, API-key auth,
missing auth, unavailable model, invalid output, and missing executable fail as
`measurement_unavailable` before manifest creation or dispatch.

Frozen before and after envelope evidence preserves raw transport provider
`openai-codex`. Runtime/provider evidence remains canonical family `openai`,
the observed route is `openai-codex-responses`, and the auth family is managed.
Pairing validates both raw and canonical identities rather than overwriting
one with the other. Exact frozen revisions
`c46aae1af1b78a6f81ea40c3099edde0ba35ebd5` and
`394c98a97428b741f8ea54273a226cb062455ab0` are covered in the public 24-arm
fixture integration.

`usage_unavailable` is now a normal pairing-eligible envelope state when cache,
source, retry, model, auth, provider, route, and execution evidence remain
clean. Its provider usage remains nullable and its availability is preserved
separately on the comparable identity. Cache mismatch remains descriptive;
retry or any other ineligible observation remains rejected, including when
combined with cache mismatch.

No provider, Electron, prepared-resource build, renderer, campaign, Hermes, or
OpenCode execution was performed. The final benchmark remains todo and the
governing Work remains in progress. After final Ledger closeout, the canonical
index and dashboard, handoff, and roadmap views are regenerated through the
Project Ledger CLI and rechecked so derived-view staleness is not waived.

Validation passed 48 focused tests including the real Butler subprocess and
139 broad provider-free benchmark/proxy/prepared-resource tests. Typecheck,
full lint with zero errors and 20 pre-existing warnings, BTCC shape, module
audit, and `git diff --check` passed. The bounded repository check reached the
broad unit phase and hit its 300.08-second limit. Its interrupted metrics CLI
child reported a null status; that exact test passed independently 1/1
immediately afterward. A full unbounded repository pass is not claimed.
After the final Task mutation, Project Ledger index and dashboard, handoff, and
roadmap views were regenerated with `--write`. Final status reported a fresh
index, no stale views, and issue count 0; final check also passed with 2,856
records and issue count 0.

## Launch-smoke cleanup lifecycle repair

Task: `T-M1-V2-LAUNCH-SMOKE-CLEANUP-LIFECYCLE-REPAIR-20260813`

The canonical harness cleanup previously inferred export requirements from
fixture M1 presence and returned `absent` before consulting typed runtime/export
authority. Consequently a provider-free renderer launch smoke could be blocked
despite dispatching no Turn, while an empty or missing runtime path could bypass
incomplete M1 launch/readiness/database/SC01 evidence.

The repair uses one typed cleanup decision. A missing or failed durable export
may clean only a successful `launch_smoke` with exactly two stopped launches,
the exact renderer/preload/gateway/native readiness set, empty provider and Turn
observations, zero rows in the exact App/BTCC/conversation authority tables, and
zero SC01 metric rows. Any provider/Turn/route/accepted-round/SC01 row requires
verified export; missing, malformed, unsafe, or unavailable authority is
`runtime_observation_ambiguous`. Runtime absence is idempotent only for an
already verified export or a genuinely not-armed non-M1 operation. It cannot
stand in for M1 authority verification.

The public paired `preflight` path runs before manifest/campaign creation in
dedicated create-only roots and records only an exact privacy-safe receipt after
the typed zero-dispatch cleanup succeeds. Receipt resume skips the adapter;
partial or symlinked roots, identity drift, ambiguous cleanup, and missing
runtime authority cannot create or promote a receipt.

Provider-free tests cover the two-launch success, exact readiness equality,
provider/Turn/route/round/SC01 export requirements, empty or missing runtime,
non-ENOENT path ambiguity, successful and partial restart, prepared-resource
identity mutation, safe receipt resume, unsafe/partial roots, adapter
classification, campaign root preservation, and the real public paired CLI
composition. No provider, live Electron, prepared build, or campaign was run.

## Durable physical-request digest repair

Task: `T-M1-V2-DURABLE-PHYSICAL-DIGEST-REPAIR-20260813`

The canonical proxy captures the bounded HMAC attempt digest before it
classifies the physical request role. The typed Step identity therefore now
models `physicalAttemptDigest` as a required identity for Agent, title,
auxiliary, and tool-provider requests. Durable evidence schema v2 preserves
each physical request exactly once with its ordinal, role, Step/Session/Turn
ownership, terminal status, provider bytes and timing, route/model/auth/tier
fields, serializer digest, and physical attempt digest. It stores no prompt,
body, response, credential, path, or reasoning content.

The durable rows are role-discriminated. Only Agent attempts may own SC01
request envelopes, segments, and nullable usage, and only their exact segment
sum enters SC01 Agent arithmetic. Non-Agent rows must be unarmed and cannot
fabricate SC01 evidence; their title, auxiliary, and tool-provider counts and
bytes are recomputed separately. A shared physical-request verifier rejects
missing, malformed, duplicate, conflicting, cross-role, cross-turn, stale,
status, timing, byte, ordinal, and retry-ownership mismatches.

Restart verification is anchored by an atomic, symlink-safe external
membership authority plus the immutable evidence SHA. A complete authority and
export independently reconstruct Agent arithmetic and non-Agent overhead.
Authority-only, evidence-only, or temporary partial crash states fail closed as
`measurement_unavailable` without replacement or provider redispatch. Report
and evaluator paths re-open the durable export instead of trusting the stored
summary.

Provider-free coverage includes the real public paired CLI through the Butler
adapter, runner fixture, provider proxy, typed identities, durable exporter,
evaluator, and report for all 24 steps. Its exact failing shape has one Agent,
one title, and one auxiliary request with distinct legitimate digests; the
Agent byte sum excludes overhead while title and auxiliary bytes remain exact.
Focused and public tests, root/UI typecheck, full lint with zero errors, BTCC
shape, module audit, and diff check passed. Sol-high independently approved the
final diff with P0-P3 none. The bounded repository-wide check again reached the
broad unit phase and hit its 301-second limit, so an unbounded full pass is not
claimed. No provider, Electron, prepared build, smoke, campaign, Hermes, or
OpenCode execution was performed, and failed Final Attempt
`A-M1-V2-FINAL-BENCHMARK-20260813-02` remains immutable.

## SC01 role-aware unarmed overhead repair

Task: `T-M1-V2-SC01-ROLE-AWARE-OVERHEAD-REPAIR-20260813`

This bounded repair starts from exact source
`c5e8bc516068cb748a4fa67df84d5eba019d189e`. The product producer emits one
request envelope, a complete ordered segment partition, and nullable response
usage for every instrumented physical provider attempt. Its `armId` is nullable:
Agent turns may carry the benchmark arm, while title, auxiliary, and
tool-provider attempts legitimately emit the same SC01 telemetry unarmed with
`armId: null`.

The durable projection must therefore preserve two disjoint classes. Agent rows
own causal SC01 envelope, segment, usage, token attribution, and reduction
arithmetic. Exactly joined non-Agent rows may own an unarmed envelope, segments,
and nullable usage, but remain role-classified physical overhead. Each overhead
envelope byte count must independently equal both its ordered segment sum and
its provider-observed serialized bytes. Durable restart, evaluator, and report
paths reopen and recompute Agent totals, per-role overhead count/bytes/usage,
and explicit all-physical totals without allowing overhead into Agent reduction
or token attribution.

Legitimate non-Agent telemetry requires an exact join across typed physical
ordinal, role, Session, Turn, Step membership when present, attempt digest,
provider bytes, route/model/tier/status, serializer digest, and terminal timing;
unarmed physical overhead may have no Step membership but still requires the
same exact provider/telemetry join. A non-Agent `armId`, missing or fabricated
rows, duplicate/conflicting rows, cross-role digest, byte or segment-order
mismatch, status mismatch, ambiguous ownership, and privacy-unsafe material
fail closed. A typed title or auxiliary request with no SC01 rows remains valid
only when producer evidence establishes that no attribution observation was
emitted; it is still preserved as typed overhead rather than ignored.

The same repair also corrects fresh-plan identity propagation. The immutable
failed Attempt -03 is not patched, normalized, reinterpreted, reconstructed, or
promoted: its persisted manifest recomputes to
`99af7c8337056bb145938a03cb6e2e4ef106c5478886d2445ad776b3706f1dd2`, while
its immutable runtime result and before/after preflight receipts carry
`20413529b0e32bedd53736b9d0ff806a6e1de83089951ba9b7fb9260ca1bd5fa`.
For future fresh plans, one canonical identity is computed exactly once from
public immutable semantic fields after private prepared-resource pins have been
resolved to their pathless identities. The identical value is then carried
through the manifest, both preflight receipts, steps, runtime result,
checkpoint, SC01 export, evaluator, and report. Runtime paths and prepared
resource directories cannot affect it; any runtime prepared-verification
identity is separately named. Any mismatch fails before fresh dispatch.

Acceptance is provider-free and focused: reproduce the Agent plus exact
591-byte title telemetry and auxiliary-overhead shape with distinct digests;
prove Agent-only versus overhead and all-physical arithmetic; cover nullable
usage and one retry; reject non-Agent segment-sum, arm tag, digest/role/ordinal,
ordering, status, duplicate, missing, conflict, and unsafe-field faults; preserve
valid typed non-emission; reproduce the historical `99af...` versus `2041...`
identity split without changing its files; and run the real public
CLI-to-proxy/runner-to-durable-export-to-evaluator/report path. Provider,
Electron, prepared-resource build, campaign, final 4x3, replacement, default,
24-step order, pin, and cleanup policy remain out of scope and unchanged.

The repair is complete. The exporter now stores optional typed overhead
observations and applies the same envelope, ordered-segment, nullable-usage,
terminal, tier, and privacy invariants during creation and durable reopen.
Agent causal bytes remain the registered reduction measure; the paired result
also publishes separately named all-physical bytes. The fresh planner computes
one pathless semantic identity, binds every Arm to it, and every manifest,
preflight, checkpoint/result, export, evaluator, and report consumer revalidates
that carried identity before dispatch or acceptance. Prepared-resource
verification remains a separately named identity.

The immutable failed Attempt -03 evidence was read only. An exact redacted
manifest fixture recomputes to `99af...`; a separate minimal allowlisted fixture
records the result and both launch-smoke receipts as `2041...`. The regression
proves the historical split without rewriting or promoting the Attempt. The
original artifact remains unchanged.

Validation passed 29 focused exporter tests, 81 focused producer/identity/
runtime-export/adapter tests, 12 public paired CLI/workflow/evaluator/report
tests, root and UI typecheck, lint with zero errors and 20 pre-existing warnings,
BTCC shape (`4 domains / 203 files`), module audit, and `git diff --check`.
Independent fast Sol review approved with P0-P3 none after two P1 findings were
repaired: full typed overhead parity and artifact-derived Attempt -03 identity
reproduction. The exporter remains a size-review trigger at roughly 660 lines,
but the reviewer found its durable materialize/verify responsibility cohesive.
Provider, Electron, prepared-resource, campaign, final 4x3, Hermes, OpenCode,
and the 300-second repository-wide check were intentionally not run.
