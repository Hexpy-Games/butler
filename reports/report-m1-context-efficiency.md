# M1 Context Efficiency — T1–T4 Final Report

Date: 2026-08-11
Tasks: `T-M1-BASELINE-TELEMETRY`, `T-M1-MINIMAL-TOOL-SURFACE`,
`T-M1-COMPACT-REPLAY-REFERENCES`, `T-M1-BOUNDED-CONTINUATION-CACHE-PREFIX`
Work: `W-M1-CONTEXT-EFFICIENCY-20260810`
Source revision: `65494154f6e9ddbfb20458bc67250c7d15b5d13d`
T3 implementation revision: `19bb803a815e4437edc2ebc55c0564aa0b12779d`
T4 implementation commit: `9ca8406de3e71ca05cae54375a16db22889b1d36`
Flag revisions: `m1-t1-v1`, `m1-t2-v1`, `m1-t3-v1`, `m1-t4-v1`

## Gate result

**PARTIAL — all four T1 pairs are reproducible and measurement-eligible. T2
and T3 are implemented and measured, with their feature flags remaining
default-off. T4 is implemented, measured, rollback-covered, and independently
approved, but its elapsed-time target and all-four-arm optimization condition
fail.**
T3 is implemented and measured at the exact implementation revision above.
Its selected controlled observations all delivered and passed quality/reload
checks. The observed descriptive aggregate exceeds the registered byte/request
hypotheses numerically, but the fixed pre-M1 direct-warm cache read `0` differs
from the selected retry's cache read `6,656`; this is not cache-state-matched
causal proof and cannot establish paired target success or default-on. The
elapsed-time target and the all-four-arm optimization condition fail, so T3
does not pass its optimization target and both optimization flags remain
default-off. T4's controlled measurement is recorded below; its flag also
remains default-off. M1 Work remains `in_progress`, not done or accepted,
because the registered 18–30% elapsed target and the all-four-arm optimization
condition fail. T5 is cancelled at the dependency gate: no Attempt, code, or
provider run occurred; no reviewed deterministic counts/IDs/ranges residual
target was identified; broad model-plan variance remained; exact cost and a
safe authority boundary were unproven; the explicit do-not-implement condition
therefore applies. No M1 success or default-on claim is authorized.

The original pre-M1 landing run stopped at initial dispatch with the bounded
error `database is locked`. A recovery run used a new detached worktree at the
same exact source revision plus a new run root, Butler data root, App database,
workspace, Electron profile, ports, and process lifecycle. The first bounded
launch did not reach a renderer or create a database; the second completed the
real product path and closed its owned processes and database handles. No third
attempt was needed.

The M1 recorder is observation-only and is not being presented as an
optimization result or default-on decision.

## Frozen control conditions

- Butler-only comparison; no Hermes/OpenCode execution and no benchmark runner
  was merged or used as a product path.
- Model: `openai/gpt-5.6-sol`; reasoning: `low`; authenticated existing Butler
  provider route; same source revision and provider configuration for the
  paired runs.
- Each arm used a fresh isolated run root and workspace. Source data was read
  only; arm workspaces were not shared.
- Fixture/scenario hashes (SHA-256): direct cold
  `4624716bb666450454d4aec9213457bdd58db7d12736653a69604b198922f6c5`, direct
  warm `443af88956780d656f3fc86bb74e92ea6786c6503a24d12c229a08b878e05f7a`,
  current web `54f79f966330ae6b66cb70f8c8bcd4f9dc0dbce51c079d296ec3f6cf15a612de`,
  landing `dd794a326167834c5021511284a4978d0d4993b374e6dd761a3c010f948d1d4f`.
- Direct warm uses its first delivered turn as the warmup and compares the
  second delivered turn as the target observation.

## Paired Butler observations

The existing Electron evidence supplies delivered state, app elapsed time,
agent request count, and serialized-request byte proxies. Existing
prompt-cache records supply provider prompt/cache/total token values. The new
typed event supplies admitted serialized-input estimates and nullable provider
classes. These units are intentionally not conflated; no raw-input reduction
claim is made where the pre-M1 admitted-input estimate was unavailable.

| Arm | Pre-M1 Butler | Post-T1 telemetry Butler | Pair status |
| --- | --- | --- | --- |
| `direct-cold` | delivered; 1 agent request; 3,572 ms; 37,476 serialized bytes; 7,154 prompt / 0 cached / 7,181 total provider tokens | delivered; 1 agent request; 4,598 ms; 37,474 serialized bytes; event input estimate 8,128; provider prompt 7,156 / cache read 0 / cache write 0 / output `null` / total 7,180; event elapsed 3,868 ms; first useful 3,867 ms; tools 0 / failures 0 | Numeric pair available; no optimization claim |
| `direct-warm` target | delivered; 1 target agent request; 5,512 ms; 38,116 serialized bytes; 7,371 prompt / 0 cached / 7,404 total provider tokens | delivered; 1 target agent request; 6,913 ms; 38,111 serialized bytes; event input estimate 8,355; provider prompt 7,373 / cache read 6,656 / cache write 0 / output `null` / total 7,404; event elapsed 4,126 ms; first useful 4,126 ms; tools 0 / failures 0 | Numeric pair available; cache state differs in observed provider field; no optimization claim |
| `current-web-cold` | delivered; 4 agent requests; 23,096 ms; 165,709 serialized bytes; 32,880 prompt / 6,656 cached / 33,383 total provider tokens | delivered; 5 agent requests; 33,652 ms; 269,385 serialized bytes; event input estimate 66,768; provider prompt 59,063 / cache read 13,312 / cache write 0 / output `null` / total 59,793; event elapsed 32,908 ms; first useful 7,509 ms; tools 9 / failures 0 | Pair computable, but provider-owned tool plan varied (4→5 requests); no optimization claim |
| `landing-cold` | delivered; 24 agent requests (15 completed usage-bearing rounds and 9 failed transport attempts); 323,542 ms; 2,019,518 serialized bytes; provider prompt 213,541 / cache read 134,656 / cache write 0 / output `null` / total 222,377 across the 15 completed rounds; first provider content 5,823 ms; expected files and reload passed | delivered; 16 agent requests (15 completed usage-bearing rounds and 1 failed transport attempt); 274,830 ms; 1,240,943 serialized bytes; event input estimate 291,811; provider prompt 221,086 / cache read 124,928 / cache write 0 / output `null` / total 229,518; event elapsed 273,670 ms; first useful 11,030 ms; tools 16 / failures 0 | Numeric and artifact-quality pair available; exact serialized bytes −38.55%, attempted requests −33.33%, elapsed −15.06%; completed rounds stayed 15→15, so no request-efficiency or optimization claim |

The post-run events were `m1_baseline_arm_observed`, `status: ok`, `unit: arm`,
with the frozen arm metadata and `rawTextStored: false`. Missing provider output
tokens remain `null`; they were not coerced to zero. The landing event's
`modelRequests: 16` correctly includes the failed transport attempt while
provider usage totals include only successful usage samples.

Across the four target observations, exact serialized request bytes are
2,260,819 pre-M1 versus 1,585,913 post-T1 (−29.85%), agent requests are 30
versus 23 (−23.33%), and App elapsed time is 355,722 ms versus 319,993 ms
(−10.04%). These are reproducible paired observations, not an optimization
result: T1 changes telemetry only, provider-owned plans varied, and serialized
bytes are not relabeled as raw tokens. The landing provider token totals cover
15 usage-bearing rounds on each side while exact serialized bytes cover all
24 pre and 16 post agent attempts. The apparent attempted-request reduction
includes a transport-failure change from 9 pre to 1 post while completed landing
rounds remain 15 to 15; neither the arm delta nor the aggregate 30 to 23 count
is request-efficiency or optimization evidence. Unavailable provider output
tokens remain `null`; partial provider fields are not treated as zeros or
complete coverage.

## Quality, source, and visual review

These are review evidence, not operational metric dimensions.

- Direct cold and warm: both pre-M1 and post-T1 observations delivered and
  passed reload matching. No factual/source judgment applies to the greeting
  scenario.
- Current web: both observations delivered. The post-T1 run completed the
  model-owned web search/document-read path and rendered a cited source; the
  harness reload check passed. Because the provider selected a different
  number of rounds, this is recorded as observed quality/source evidence, not
  a regression-free optimization result.
- Landing: both observations delivered, satisfied the frozen expected-file
  assertions, built successfully, and matched after reload. Independent static
  checks at 1,440 px desktop and 390 px mobile found zero console errors, zero
  broken images, and zero horizontal overflow on both artifacts. The recovered
  pre-M1 artifact had 8 interactive elements versus 7 post-T1 and passed visual
  review at desktop/mobile top and bottom captures. Its Guided Work metadata
  remained `open` and its final copy conservatively described unfinished
  validation despite the persisted build/preview evidence; this is retained as
  a baseline reporting discrepancy, not hidden or scored as post-T1 quality.
  The post-T1 observation completed its Work, so there is no regression.
- The recovered pre-M1 run persisted 18 unique completed guided tool calls,
  14 unique durable result references, and 4 unique applied effect receipts /
  idempotency keys. The post-T1 observation records zero duplicate effects,
  stalls, lost corrections, or workspace-authority violations. No duplicate
  effect or lost-correction regression was found in the pair.

## Privacy and rollback

- The recorder accepts only finite arm/scenario/reasoning/state enums, an exact
  40-character source SHA, a canonical model reference, and the fixed flag
  revision format. Private paths, URLs, free text, and credential-like values
  are rejected and become `measurement-ineligible` without being persisted.
- Unit coverage verifies redaction, unavailable-as-`null`, known zero counters,
  provider output-only usage, idempotent finalization, and invalid metadata.
- `BUTLER_M1_BASELINE_TELEMETRY` is the single observation selection point and
  defaults on only for best-effort diagnostics. The real Guided Turn flag-off
  test preserves the turn result and emits no M1 event. Recorder failures are
  swallowed and cannot veto a turn.
- Route fallback events mark the arm measurement-ineligible and update the
  active model reference; the existing ModelRouteState/createModelRoutePort
  authority remains unchanged.

## Call-path and implementation evidence

The verified path is `Session/BTCC ingress timestamp → BTCC turn runtime →
production Guided Turn agent → usage attribution/provider adapter → operational
metric recorder`. The post-run Electron smoke used the actual renderer,
preload bridge, app gateway, native BTCC runtime, real provider, and delivered
renderer path.

T1 implementation is limited to telemetry and provider-nullability plumbing: a
typed M1 recorder, ingress timestamp propagation, cohesive Guided Turn
observation/route-event helpers, provider-reported token-class fields, fallback
ineligibility handling, SQLite result normalization, and unit/real path tests.
T2 adds the default-off minimal carrier and its typed observation through the
same production Guided Turn path. T3 adds default-off exact-first compact replay,
durable result references, deterministic exact-read recovery, restart continuity,
mechanical Work-state receipts, and bounded typed operation rejection through
that same Guided Turn path. T4 bounded continuation/cache-prefix
implementation, measurement, rollback, and review are recorded in the T4
section below. T5 was cancelled at the dependency gate without an Attempt,
code, or provider run; no reviewed deterministic counts/IDs/ranges residual
target existed, broad model-plan variance remained, exact cost and a safe
authority boundary were unproven, and the explicit do-not-implement condition
applies. No M1 success or default-on claim is authorized.

## Validation and review

- Focused tests: M1 recorder 6 passed; Guided Turn agent 49 passed; provider
  usage 4 passed; production public-path M1 test 1 passed; OpenAI prompt-cache
  compatibility 2 passed; Guided Turn runtime 17 passed; BTCC facade 3 passed.
- `bun run typecheck`: passed.
- `bun run lint:btcc-shape`: passed (4 domains, 205 files).
- `git diff --check`: passed.
- `bun run lint`: passed with 0 errors; 20 repository warnings remain,
  including four existing warnings in the large Guided Turn test file.
- Repo privacy hygiene and the focused T1 suite pass 84/84 after replacing an
  operator-specific redaction-test path with a generic absolute private path;
  production behavior is unchanged.
- `bun run check`: the 2,531-test suite reached 2,530 pass / 1 fail after that
  correction. The
  unrelated existing failure is `tests/unit/butler-cli-docs.test.ts` because
  the CLI reference contains 102 documented commands while the registry
  currently exposes 101; no CLI reference or registry file is in this diff.
- Project Ledger: original attempt `A-M1-T1-20260810` remains failed as
  historical evidence. Recovery attempt
  `A-M1-T1-LANDING-RECOVERY-20260810` and Task
  `T-M1-BASELINE-TELEMETRY` are closed after this report's phase commit; the
  M1 Work remains `in_progress`, not done or accepted, because the registered
  18–30% elapsed target and all-four-arm optimization condition fail. T5 was
  cancelled at the dependency gate without an Attempt, code, or provider run;
  no reviewed deterministic counts/IDs/ranges residual target existed, broad
  model-plan variance remained, exact cost and a safe authority boundary were
  unproven, and the explicit do-not-implement condition applies. Derived
  index/views and final check are refreshed after lifecycle closeout.
- Targeted ESLint: 0 errors.
- T2 focused suite: 273/273 passed across nine files, including the real Guided
  Turn route-fallback metric test and the native flag-on file-agent product
  loop. `bun run typecheck`, `bun run lint:btcc-shape` (4 domains, 207 files),
  targeted ESLint, and `git diff --check` passed.
- The ordinary `bun run check` wrapper reached its repository-wide 301-second
  timeout while the suite was still progressing. Running the same `check:run`
  pipeline without that wrapper limit completed 2,541 pass / 1 unrelated
  existing failure: the CLI reference still contains 102 documented commands
  while the registry exposes 101. T2 does not change CLI docs or registry
  files. Repository lint completed with 0 errors and the same 20 warnings.
- Windows CI was excluded per the governing decision.
- First independent gpt-5.6-sol high review: **changes required**. Findings
  were addressed: ingress timing now begins before preparation, metadata uses
  strict safe identifiers, fallback arms are ineligible, counters initialize
  at known zero, provider output is direct/nullable, the production public
  path is exercised through the real composition, and the Guided Turn file is
  below the BTCC shape limit. Final independent gpt-5.6-sol high re-review:
  **APPROVE**, no actionable findings.
- Independent recovery integrity review first required disclosure that the
  24→16 landing attempt difference was 15 completed rounds on both sides plus
  failed-transport asymmetry of 9→1. The report now makes that distinction and
  forbids request-efficiency/optimization interpretation. Final independent
  gpt-5.6-sol high recovery re-review: **APPROVE**, no actionable findings.
- Domain module audit reported 15 existing size/index review triggers across
  the inspected BTCC/metrics roots. This recovery changes no source module
  boundary; BTCC shape remains passing (4 domains, 205 files).

## Frozen comparison boundary and final adjacent diagnostic table

The final adjacent diagnostic table below uses only the frozen #142
commit/report data; no benchmark rerun occurred. The frozen #142 pilot used
baseline commit `549463fbe074fc25042f9302cd330699948dab50`, model
`openai/gpt-5.6-sol`, and medium reasoning. All 12/12 observations across
Butler+Hermes+OpenCode were rejected; ranking and accepted-result-per-token
claims remain withheld. #142 was not merged and was not rerun.

| Arm | frozen #142 Hermes total tokens / requests / elapsed | frozen #142 OpenCode total tokens / requests / elapsed | fixed pre-M1 Butler serialized bytes / requests / elapsed | post-M1 T4 selected controlled observation serialized bytes / requests / elapsed |
| --- | --- | --- | --- | --- |
| direct cold | 9,169 / 4 / 27,914 ms | 14,357 / 4 / 17,004 ms | 37,476 / 1 / 3,572 ms | 43,926 / 1 / 5,874 ms |
| direct warm | 5,598 / 4 / 25,873 ms | 14,467 / 4 / 22,390 ms | 38,116 / 1 / 5,512 ms | 44,580 / 1 / 5,369 ms |
| current web cold | 64,609 / 7 / 130,470 ms | 130,714 / 2 / 49,769 ms | 165,709 / 4 / 23,096 ms | 159,394 / 3 / 34,182 ms |
| landing cold | 178,205 / 9 / 307,708 ms | 114,001 / 5 / 245,574 ms | 2,019,518 / 24 / 323,542 ms | 873,525 / 12 / 282,985 ms |

The #142 columns are provider total tokens, requests, and elapsed under a
different baseline and medium reasoning. M1 reports exact serialized bytes,
requests, and elapsed under low reasoning at source revision
`65494154f6e9ddbfb20458bc67250c7d15b5d13d`. These are adjacent diagnostic
context only, not a direct ratio, paired causal comparison, or ranking. The
T3/T4 warm cache mismatch remains disclosed in the respective sections below.

The fixed pre-M1 aggregate is 2,260,819 bytes / 30 requests / 355,722 ms;
the post-M1 T4 selected controlled observation is 1,121,425 bytes / 17
requests / 328,410 ms: descriptive deltas of −50.40% / −43.33% / −7.68%.
Because the selected post-M1 warm cache read differs from the fixed pre-M1
warm cache read, these are not cache-state-matched causal proof; the registered
18–30% elapsed target fails.

## T2 minimal tool surface

### Product-path design and rollback

- `BUTLER_M1_MINIMAL_TOOL_SURFACE` is read once at the immutable Guided policy
  boundary immediately before the existing surface controller. It defaults
  off. Removing the variable or setting it to a non-true value selects the
  byte-identical legacy provider carrier without changing the executor,
  provider adapter, or route authority.
- Selection uses typed phase policy plus the canonical session
  `WorkspaceReference`; prompt text is not inspected. Full typed authorization
  remains available to the one real executor, while the fixed provider carrier
  presents direct common schemas and the existing progressive discovery bridge.
- The provider carrier is fixed for the phase. Dynamic App/native availability
  changes local admission metadata only and does not rebuild provider schemas.
  Route cursor changes continue through `ModelRouteState` and the existing
  provider route port; the telemetry provider/model pair is derived together
  from the active route candidate.
- A full-access project carrier changed from 19,743 to 12,800 serialized schema
  bytes (−35.17%, 14 model-facing tools). A full-access non-project carrier
  changed from 16,105 to 7,519 bytes (−53.31%, 8 model-facing tools). Flag-off
  schemas are byte-identical to the pre-T2 path.

### Paired Butler measurements

All rows use the frozen pre-M1 source/configuration/fixtures and
`openai/gpt-5.6-sol` with low reasoning. Each T2 arm used a fresh isolated run
root and workspace. Hermes/OpenCode were not run.

| Arm | Fixed pre-M1 Butler | T2 flag-on Butler | Pair result |
| --- | --- | --- | --- |
| `direct-cold` | delivered; 1 request; 37,476 serialized bytes; 3,572 ms; provider prompt 7,154 / cache read 0 / total 7,181 | delivered and reload matched; 1 request; 28,336 bytes; 4,069 ms; provider prompt 5,540 / cache read 0 / total 5,564; first useful 3,353 ms; 0 tool calls / 0 failures | bytes −24.39%; requests unchanged; elapsed +13.91% |
| `direct-warm` target | delivered; 1 request; 38,116 serialized bytes; 5,512 ms; provider prompt 7,371 / cache read 0 / total 7,404 | delivered and reload matched; 1 request; 28,979 bytes; 3,413 ms; provider prompt 5,764 / cache read 0 / total 5,797; first useful 2,041 ms; 0 tool calls / 0 failures | bytes −23.97%; requests unchanged; elapsed −38.08%; observed cache read remained 0 |
| `current-web-cold` | delivered; 4 requests; 165,709 serialized bytes; 23,096 ms; provider prompt 32,880 / cache read 6,656 / total 33,383 | delivered, source expectation and reload matched; 3 requests; 103,688 bytes; 15,443 ms; provider prompt 21,230 / cache read 6,656 / total 21,618; first useful 3,477 ms; 3 tool calls / 0 failures | bytes −37.43%; requests −25.00%; elapsed −33.14% |
| `landing-cold` | delivered; 24 attempted requests (15 completed and 9 failed transport attempts); 2,019,518 serialized bytes; 323,542 ms; provider prompt 213,541 / cache read 134,656 / total 222,377 across completed rounds | delivered and reload matched; 12 completed requests; 923,351 bytes; 481,642 ms; provider prompt 142,301 / cache read 48,128 / total 151,074; first useful 11,096 ms; 15 tool calls / 0 failures | bytes −54.28%; attempted requests −50.00%; elapsed +48.87% |

Across the four arms, serialized request bytes changed from 2,260,819 to
1,084,354 (−52.04%), requests from 30 to 17 (−43.33%), and elapsed time from
355,722 ms to 504,567 ms (+41.84%). Provider prompt totals changed from 260,946
to 174,835 (−33.00%), provider total tokens from 270,345 to 184,053 (−31.92%),
and cache reads from 141,312 to 54,784 (−61.23%). Provider output tokens remain
nullable and are not treated as zero.

The raw-input and request-count hypotheses pass for this slice, but the elapsed
hypothesis fails because the landing arm regressed. T2 is therefore complete as
a default-off implementation slice, not accepted for default-on. T3 and T4 are
reported in their own sections below; neither can retroactively turn this
slice-local elapsed result into a pass. The combined four-arm measurement must
pass before any final default-on decision.

### T2 quality, privacy, and operational evidence

- All four final observations delivered and matched after reload. The web arm
  passed its source expectation. The landing arm changed the expected HTML/CSS
  artifacts, passed its build and preview checks, and used the actual project
  workspace/native tool path. Its Work remained open, matching the fixed
  pre-M1 baseline state; the elapsed regression remains explicitly recorded.
- Applied landing effects had unique receipt and idempotency identities. No
  duplicate effects, stalls, lost corrections, workspace-authority violations,
  or tool failures were observed.
- The real native file agent-loop smoke discovers, reads, edits, rereads, and
  delivers workspace files with the flag on. It uses no shell or Python
  fallback and shares the same executor and `WorkspaceReference` as direct
  tools and progressive calls.
- `m1_tool_surface_admission` records only the approved typed dimensions:
  phase/policy/authority digests, provider/model, stable schema hash, dynamic
  availability hash, flag revision, and nullable count/byte/token estimates.
  It measures the actual model-facing provider carrier. Invalid identifiers,
  paths, credential-like values, prompts, transcripts, URLs, queries, and raw
  tool payloads are not persisted.
- The independent gpt-5.6-sol high review first required a real provider-carrier
  reduction, fixed-schema dynamic admission, actual carrier telemetry, and
  closeout evidence. A progressive-only carrier was rejected because it added
  web requests and allowed a landing run to finish without changing expected
  files. The corrected hybrid carrier retained direct common typed tools while
  keeping less-common authorized capabilities behind the existing progressive
  bridge. A follow-up review found and corrected provider/model telemetry drift
  after a route cursor fallback; the production Guided Turn regression now
  covers an active provider different from the original selection.

## T3 exact-first compact replay and durable references

### Frozen boundary and observation selection

- Exact implementation revision:
  `19bb803a815e4437edc2ebc55c0564aa0b12779d`.
- All four selected T3 observations used the frozen direct-cold, direct-warm,
  current-web, and landing fixture hashes recorded above, model
  `openai/gpt-5.6-sol`, reasoning `low`, fresh isolation, and the T2 plus T3
  default-off flags explicitly enabled for measurement. No Hermes, OpenCode,
  T4, fallback benchmark path, or unfrozen fixture was used.
- The fixed pre-M1 direct-warm observation reported provider cache read `0`. A
  delivered T3 warm-cache-read-`0` observation was excluded from the selected
  controlled observation. The selected retry reported provider cache read
  `6,656` and is the controlled observation shown below; it is not
  cache-state-matched paired-eligible with the fixed pre-M1 observation.
- One fresh landing setup attempt failed before provider dispatch because the
  bundled archive extraction exceeded its setup timeout. It recorded zero
  provider requests and is excluded. A clean retry, followed by the exact-SHA
  final run, succeeded; only the final selected exact-SHA controlled observation
  is used below.

### Controlled descriptive observations

Elapsed values in this table and its aggregate math are App observation
elapsed on both sides; metric-event elapsed is not used in the comparison. The
selected direct-warm retry is a controlled descriptive observation, not a
cache-state-matched paired-eligible observation or causal proof.

| Arm | Fixed pre-M1 Butler | T3 selected controlled observation | Descriptive delta / evidence |
| --- | --- | --- | --- |
| `direct-cold` | 37,476 serialized bytes; 1 request; 3,572 ms | delivered and reload matched; 43,850 bytes; 1 request; 7,010 ms | bytes +17.01%; requests unchanged; elapsed +96.25% |
| `direct-warm` selected retry | 38,116 serialized bytes; 1 request; 5,512 ms; provider cache read 0 | delivered and reload matched; 44,502 bytes; 1 request; 3,410 ms; provider cache read 6,656 | bytes +16.75%; requests unchanged; elapsed −38.13%; not cache-state-matched paired-eligible |
| `current-web-cold` | 165,709 serialized bytes; 4 requests; 23,096 ms | delivered, source expectation passed, and reload matched; 211,882 bytes; 4 requests; 52,284 ms | bytes +27.86%; requests unchanged; elapsed +126.38% |
| `landing-cold` | 2,019,518 serialized bytes; 24 attempted requests; 323,542 ms | delivered and reload matched; 706,912 bytes; 10 requests; 264,178 ms | bytes −65.00%; requests −58.33%; elapsed −18.35% |

Across the four selected controlled observations, exact serialized request bytes changed from
2,260,819 pre-M1 to 1,007,146 under T3 (−55.45%), requests from 30 to 16
(−46.67%), and elapsed time from 355,722 ms to 326,882 ms (−8.11%). Relative
to the T2 aggregate, T3 changed bytes from 1,084,354 to 1,007,146 (−7.12%),
requests from 17 to 16 (−5.88%), and elapsed time from 504,567 ms to 326,882 ms
(−35.22%). These exact arithmetic results are descriptive controlled-observation
deltas only. Because the fixed pre-M1 direct-warm cache read was `0` and the
selected retry cache read was `6,656`, they are not cache-state-matched causal
proof and cannot establish paired target success or default-on.

The observed descriptive aggregate exceeds the registered byte/request
hypotheses numerically, but the cache mismatch means it cannot establish
cache-state-matched paired target success or default-on. The registered 18–30%
elapsed-time target fails because the aggregate elapsed time improved by only
8.11%, and the all-four-arm optimization condition fails because direct cold
and current web regressed materially. T3 is therefore implemented and
measured with hypotheses partially unmet. This is not a T3 target-success or
default-on claim; `BUTLER_M1_MINIMAL_TOOL_SURFACE` and
`BUTLER_M1_COMPACT_REPLAY` remain default-off.

### Quality, exact-read, effect, and review evidence

- All four selected controlled observations delivered, passed their frozen
  quality expectations, and matched after reload. The web arm passed its source
  requirement. This is retained as quality/reload evidence; it does not make
  the selected warm observation cache-state-matched or establish causal
  optimization evidence.
- The final landing Work reached `completed` / `reporting`; its Plan Review,
  result Review, and completion Validation were all `accept`.
- Landing exact reads were 2 attempts / 2 successes / 0 failures, with
  `duplicateEffect: false`. Its two applied effects had two distinct
  idempotency keys; no duplicate effect was observed.
- Compact replay retained newest coherent batches, exact result identities,
  selected views, structural operation outcomes, and mechanical Work state
  across same-Turn restart. Invalid reads and correction-recovery admission
  remained typed same-phase operation rejections and did not mutate Work or
  redispatch source/effect operations.
- No private path, prompt, transcript, raw operation payload, semantic
  correction text, provider prose, credential, or hidden reasoning is included
  in this report or the compact optimization records.

### Validation and independent review

- The final full check completed with 2,584 tests passed and one unrelated known
  failure: CLI documentation lists 102 commands while the registry exposes 101.
  T3 changes neither CLI documentation nor the command registry.
- Focused compact-replay, Guided production-path, restart, route, Work-state,
  exact-read, privacy, typecheck, targeted lint, BTCC shape, module, and diff
  checks passed at the implementation revision.
- Final independent `gpt-5.6-sol` high review: **APPROVED**, with no P0, P1, or
  P2 findings remaining after the bounded carrier, persistence privacy,
  restart, Work-state, and correction-recovery fixes.

## Recovery integrity evidence

- Exact detached source: `65494154f6e9ddbfb20458bc67250c7d15b5d13d`;
  fixture hash remained
  `dd794a326167834c5021511284a4978d0d4993b374e6dd761a3c010f948d1d4f`;
  model `openai/gpt-5.6-sol`, reasoning `low`, full-access product route, and
  authenticated source configuration were unchanged.
- The prior failed databases had no current owners and all App, conversation,
  and session SQLite `quick_check` calls returned `ok`. Historical lifecycle
  evidence shows distinct run-local bootstrap/executor ownership, immediate
  dispatch contention, a parked same-logical-turn continuation, and later
  process termination. This supports a run-lifecycle collision rather than
  persistent database damage.
- The successful retry used Electron renderer → preload bridge → App gateway →
  native BTCC runtime → real provider → renderer-visible final → App database
  Work lifecycle. It used no executor replacement. Both owned PIDs exited,
  no SQLite file remained open, and all three database `quick_check` calls
  returned `ok` after shutdown.
- No prompt, transcript, raw tool argument/result, credential, URL/query,
  hidden reasoning, private path, or secret is included in this report.

## Decision

The four-arm T1 evidence is complete and passes M1-SC01, M1-SC05, and M1-SC06.
The recovered baseline integrity is independently approved. T2, T3, and T4 are
implemented, measured, rollback-covered, and independently reviewed at their
recorded revisions. T3's selected controlled observations show descriptive
aggregate byte/request deltas that numerically exceed the registered
hypotheses, but the warm cache mismatch means they are not cache-state-matched
causal proof and cannot establish paired target success or default-on. T3's
elapsed target and all-four-arm condition fail. T4's selected controlled
observations likewise remain descriptive and non-causal; its elapsed target and
all-four-arm condition fail. T4 is closed as an implemented, measured, and
rollback-covered default-off slice, not as a target success. T5 is cancelled at
the dependency gate without an Attempt, code, or provider run; no reviewed
deterministic counts/IDs/ranges residual target existed, broad model-plan
variance remained, exact cost and a safe authority boundary were unproven, and
the explicit do-not-implement condition applies. M1 Work remains
`in_progress`, not done or accepted, because the 18–30% elapsed target and
all-four-arm condition fail. No M1 success or default-on claim is authorized;
no completed push or PR is recorded here, and no merge is authorized. Any
push/PR action may occur later outside this report.

## T4 bounded continuation and stable cache prefix

### Implementation and authority

- Implementation commit: `9ca8406de3e71ca05cae54375a16db22889b1d36`
  (`feat(agent): bound turn continuation and cache prefix`). The final Sol
  high review is **APPROVE**; after review/fix cycles there are no P0, P1, or
  P2 findings.
- The latest higher-priority once-admitted/no-reset invariant moved flag/env
  selection out of SQLite and into Turn-admission composition. SQLite persists
  only the injected selection. The Guided route derives enablement solely from
  persisted Turn state, preserving one authority and avoiding a second reset
  source.
- A T4-enabled `createModelRoutePort` requires the prepared provider-adapter
  request and all durability collaborators. The real route therefore cannot
  silently omit the request-admission or persistence boundary.
- Local exact serialization is measured after the T3 transformation and before
  the provider adapter. It is not a raw HTTP measurement; Sol explicitly
  reviewed this placement and ruled that it matches the Spec.
- The Turn-v1 durable ref bound is a stable domain invariant of 8 refs per tool
  round, bound to the Turn schema version. It has no dependency on a T3
  compact-replay constant.

### Controlled conditions and limits

- Model: `openai/gpt-5.6-sol`; reasoning: `low`; same frozen fixture hashes
  recorded in the preceding T1–T3 sections; T2, T3, and T4 were enabled for
  this controlled measurement only. No Hermes/OpenCode run was performed.
- The final controlled T4 limits were explicitly set once at Turn admission:

| Limit | Value |
| --- | ---: |
| `maxModelRequests` | 60 |
| `maxToolRounds` | 60 |
| `maxPromptTokens` | 2,000,000 |
| `maxOutputTokens` | 500,000 |
| `maxElapsedMs` | 1,800,000 |
| `maxIdleMs` | 300,000 |

- Measurement flags were on only for the controlled run. T2, T3, and T4 remain
  default-off operationally; the verified T4 flag revision is `m1-t4-v1`;
  Windows was excluded.

### Real smoke and rollback evidence

- Exhaustion web smoke: `maxModelRequests=1` delivered and reloaded with
  exactly one provider request. Persisted state recorded model `1`, tool `1`,
  and terminal reason `max_model_requests`; the typed terminal metric had
  `rawTextStored=false`. No second dispatch occurred and SQLite `quick_check`
  was `ok`.
- Flag-off direct smoke delivered and passed quality/reload checks with one
  provider request, zero T4 metrics, and zero budgeted Turns. This is the
  rollback/default-off evidence.

### Controlled T4 observations

The T4 comparison uses the fixed pre-M1 observations already recorded above
and one transparently selected controlled observation for each arm. It is not a
cache-state-matched eligible set: fixed pre-M1 direct-warm provider cache read
was `0`; two delivered T4 warm attempts also reported cache read `0` and were
excluded; the reported third controlled T4 warm observation reported cache read
`4,608`. Any warm or aggregate delta using that third observation is therefore
descriptive controlled-observation evidence, not cache-state-matched causal
proof, and cannot support default-on or target success.

| Arm | Fixed pre | T4 controlled observation | Delta / evidence |
| --- | --- | --- | --- |
| `direct-cold` | 37,476 bytes / 1 request / 3,572 ms | 43,926 bytes / 1 request / 5,874 ms; prompt 8,016 / cache 0 / total 8,046 | bytes +17.21%; requests 0%; elapsed +64.45% |
| `direct-warm` third controlled observation | 38,116 / 1 / 5,512 ms; provider cache read 0 | 44,580 / 1 / 5,369 ms; prompt 8,237 / cache read 4,608 / total 8,270 | bytes +16.96%; requests 0%; elapsed −2.59%; not cache-state-matched paired-eligible |
| `web` | 165,709 / 4 / 23,096 ms | 159,394 / 3 / 34,182 ms; prompt 31,142 / cache 0 / total 32,357; budget model 3 / tool 2 / refs 4 active | bytes −3.81%; requests −25%; elapsed +48%; source, quality, and reload passed |
| `landing` | 2,019,518 / 24 / 323,542 ms | 873,525 / 12 / 282,985 ms; prompt 179,391 / cache 39,936 / total 191,727; budget model 12 / tool 10 / refs 15 active | bytes −56.75%; requests −50%; elapsed −12.54%; Work completed/reporting, Plan/result/completion reviews accepted, exact reads 2/2/0, duplicate effect false, applied effects 2 with 2 unique keys, 3 DB `quick_check` calls `ok` |

### Per-arm T4 state and quality evidence

- Direct cold: delivered; scenario expectations passed; reload matched; accepted
  quality/measurement observation.
- Direct warm, third controlled observation: delivered; scenario expectations
  passed; reload matched; controlled-observation only and not
  cache-state-matched paired-eligible.
- Web: delivered; source/quality expectations passed; reload matched; accepted
  controlled observation.
- Landing: delivered; expectations passed; reload matched; Work completed /
  reporting with Plan/result/completion reviews accepted. Build exit `0` and
  desktop `1,440` / mobile `390` rendering with no horizontal overflow were
  recorded in the model-owned completion review. This is separate
  quality/visual report evidence, not an operational metric and not a #142
  score/ranking; no manual visual scoring is claimed.

Aggregate fixed pre is 2,260,819 bytes / 30 requests / 355,722 ms. T4 is
1,121,425 bytes / 17 requests / 328,410 ms: bytes −50.40%, requests −43.33%,
elapsed −7.68%. These are descriptive controlled-observation deltas, not
cache-state-matched causal proof, because the selected direct-warm observation
does not match the fixed pre cache state. Against T3's 1,007,146 bytes / 16
requests / 326,882 ms, T4 is +11.35% bytes, +6.25% requests, and +0.47%
elapsed. None of these deltas supports default-on or target success.

### T4 validation and decision

- Focused T4 validation covered 114 tests and 789 assertions. Typecheck,
  changed lint, BTCC shape (`4 domains / 238 files`), and `git diff --check`
  passed. The changed-lint result contains only two pre-existing migration
  warnings; no new warning is attributed to T4.
- Full `bun run check` did not pass: it timed out at `300.10s` with an
  unrelated app-session-summary detached-worktree git-availability assertion.
  This is a known non-T4 failure and is not recorded as a full-check pass.
- The selected observations show aggregate byte/request reductions against
  fixed pre, but these are descriptive controlled-observation deltas only. The
  registered 18–30% elapsed target fails: direct warm improved by 2.59%, but
  the aggregate was only −7.68%, while direct cold and web elapsed results
  regressed. The all-four-arm optimization condition therefore fails. T4 is
  implemented, measured, and rollback-covered, but it is not target success.
- `BUTLER_M1_MINIMAL_TOOL_SURFACE`, `BUTLER_M1_COMPACT_REPLAY`, and
  `BUTLER_M1_BOUNDED_CONTINUATION_CACHE` remain default-off. No M1 default-on
  decision is authorized. T5 is cancelled at the dependency gate without an
  Attempt, code, or provider run; no reviewed deterministic counts/IDs/ranges
  residual target existed, broad model-plan variance remained, exact cost and a
  safe authority boundary were unproven, and the explicit do-not-implement
  condition applies. No M1 success or default-on claim is authorized, and no
  Hermes/OpenCode rerun was performed.

## Sol-medium replication (ordinary mode)

This section is an additive replication record. It does not overwrite the
earlier low-reasoning observations or the frozen #142 diagnostic table. The
replication used `openai/gpt-5.6-sol` with reasoning `medium`, the exact fixed
pre-M1 source `65494154f6e9ddbfb20458bc67250c7d15b5d13d`, and the current M1
source `20054194d1d404c38ba84ab8632b6fce98377c9f`. The same four fixture
hashes, Electron → preload → App gateway → native BTCC → authenticated real
provider → renderer final → persistence/reload path, and fresh run-local
workspace/DB/profile/ports/process lifecycle were used. T2, T3, and T4 were
explicitly enabled only for post-M1; T5 was not implemented or run. Baseline
recorder metadata used the accepted `m1-t1-v1` format while the implementation
events retained `m1-t2-v1`, `m1-t3-v1`, and `m1-t4-v1` revisions.

The finite T4 admission limits were fixed for every post arm: 60 model
requests, 60 tool rounds, 2,000,000 prompt tokens, 500,000 output tokens,
1,800,000 elapsed milliseconds, and 300,000 idle milliseconds. These are
Turn-scoped physical measurement bounds for this replication, not a default-on
decision. No hidden retry was introduced: every provider retry is represented
as an attempted request and route event, while usage totals include only
completed usage-bearing provider records.

### Before → change → effect

**Before.** The pre-medium control is Butler-only at the fixed source and the
same authenticated provider route. Direct-warm uses its first delivered turn
as warmup; only the second delivered turn is the target. The pre warmup was
`37,528` serialized bytes / 1 completed request / `8,281` ms; it is retained
outside the target aggregate.

**Change.** The post-medium run turned on the three default-off M1 flags at the
existing Guided Turn boundary. No benchmark-only executor, fake provider,
semantic router, extra authority, or source-string proof was used. Work/Plan/
Review/Project Ledger, memory/context recall, durable references, exact-read,
restart continuity, and typed effect boundaries remained in the product
envelope. The arm recorder and provider usage fields are diagnostic; they do
not attribute token cost to an individual M1 slice.

**Effect.** The table uses `attempted/completed` requests and serialized bytes
so transport retries cannot disappear from the raw product-cost view. Provider
usage is `prompt/cache-read/total`; output tokens were unavailable and remain
`null` rather than being coerced to zero. Direct-warm rows are target-only;
warmup details follow the table.

| arm | pre-medium bytes; requests; elapsed | post-medium bytes; requests; elapsed | pre provider prompt/cache/total | post provider prompt/cache/total | quality/capability evidence |
| --- | --- | --- | --- | --- | --- |
| direct-cold | 37,540; 1/1; 10,636 ms | 87,888; 2/1; 11,899 ms | 7,174 / 6,656 / 7,204 | 8,016 / 0 / 8,048 | delivered, expectations/reload pass; one provider retry recorded |
| direct-warm target | 38,180; 1/1; 8,293 ms | 44,575; 1/1; 10,417 ms | 7,383 / 0 / 7,412 | 8,241 / 4,608 / 8,269 | delivered, expectations/reload pass; cache state differs |
| current-web-cold | 221,929; 5/5; 60,166 ms | 398,786; 8/6; 103,942 ms | 44,537 / 33,280 / 45,551 | 62,290 / 21,504 / 64,817 | delivered, source/reload expectations pass; two provider retries recorded |
| landing-cold | 2,106,025; 21/21; 404,237 ms | 1,803,062; 23/22; 564,210 ms | 390,199 / 190,976 / 402,727 | 368,474 / 93,184 / 391,156 | delivered, build/artifact/reload checks pass; Work completed with accepted Plan/result/completion reviews |

The post direct-warm warmup itself was `43,914` bytes per attempted request,
2 attempted / 1 completed request, `10,115` ms, and provider
`8,012 / 0 / 8,044`; the target comparison intentionally excludes it. The
post direct-cold first provider attempt failed with a typed provider error and
the second succeeded; the first post metadata-only run using invalid
`m1-t4-v1` was excluded before this accepted rerun and is not included in any
row or aggregate. That excluded run still delivered/reloaded with one
usage-bearing request (`43,926` serialized bytes; provider `8,012 / 0 / 8,042`)
and is retained only as setup evidence, never as an accepted observation.

Using attempted product cost for all four target arms, pre-medium is
`2,403,674` bytes / `28` requests / `483,332` ms and post-medium is
`2,334,311` bytes / `34` requests / `690,468` ms: −2.89% bytes, +21.43%
requests, and +42.86% elapsed. Completed-only post usage is
`2,146,228` bytes / `30` requests; it is secondary evidence and does not erase
the failed transport payloads. Completed usage-bearing provider totals across
the target arms are pre `449,293` prompt / `230,912` cache-read / `462,894`
total tokens and post `447,021` / `119,296` / `472,290`. These aggregate token
classes are end-to-end observations, not feature-level attribution, and do not
establish raw-input-token reduction.

### Eligibility, low comparison, and frozen adjacent diagnostics

The medium pairs are descriptive only. Direct-cold, web, and landing have
different retry asymmetries between pre and post; provider cache-read values
also differ for direct-cold (`6,656` → `0`), direct-warm (`0` → `4,608`), web
(`33,280` → `21,504`), and landing (`190,976` → `93,184`). No
cache-state-matched causal claim is therefore eligible. All eight target observations delivered,
matched after reload, and passed frozen expectations; landing additionally
persisted the expected files and completed its build/work review path. Quality,
source, and visual findings remain separate review evidence rather than metric
dimensions. Independent ordinary-mode Sol-high review approved this evidence
after the manifest cache correction, with no remaining P0/P1/P2 findings; this
is review approval of the evidence, not an M1 optimization or default-on claim.

For context, the earlier low-reasoning T4 selected observations were
`2,260,819` → `1,121,425` serialized bytes, `30` → `17` requests, and
`355,722` → `328,410` ms (−50.40%, −43.33%, −7.68%). That is a distinct,
warm-cache-mismatched, descriptive set and must not be combined with this
medium replication.

The frozen #142 adjacent figures are unchanged and remain non-ranking
diagnostics because all 12/12 Hermes/OpenCode/Butler observations were strict
evaluator-rejected: direct-cold Hermes `9,169 / 4 / 27,914 ms`, OpenCode
`14,357 / 4 / 17,004 ms`; direct-warm `5,598 / 4 / 25,873 ms` and
`14,467 / 4 / 22,390 ms`; current-web `64,609 / 7 / 130,470 ms` and
`130,714 / 2 / 49,769 ms`; landing `178,205 / 9 / 307,708 ms` and
`114,001 / 5 / 245,574 ms`. Those provider-total-token figures used a
different frozen pilot and are adjacent context only—not a ratio, ranking, or
accepted-result-per-token claim. #142 remains a separate benchmark branch/PR.

### Acceptance and continuation decision

The registered raw-input target (≥30% reduction) is not met or measurable from
these medium pairs: serialized bytes are a request-size proxy, and the paired
provider prompt aggregate changes by only −0.51% without raw-input attribution.
The request hypothesis (45 → 38–40) is not met under attempted accounting
(`28` → `34`), and the elapsed hypothesis (18–30%) regresses (`+42.86%`). No
default-on or M1-success claim is authorized. The M1 flags remain default-off;
Work remains `in_progress`; T5 remains skipped. Windows CI remains excluded.
