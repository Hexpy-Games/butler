# M1 Context Efficiency — T1 Baseline and Telemetry Report

Date: 2026-08-10
Task: `T-M1-BASELINE-TELEMETRY`
Work: `W-M1-CONTEXT-EFFICIENCY-20260810`
Source revision: `65494154f6e9ddbfb20458bc67250c7d15b5d13d`
Flag revision: `m1-t1-v1`

## Gate result

**PASS — all four T1 pairs are reproducible and measurement-eligible.**
T2–T5 have not started in this report phase.

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

Implementation is limited to T1 telemetry and its provider-nullability
plumbing: a typed M1 recorder, ingress timestamp propagation, cohesive Guided
Turn observation/route-event helpers, provider-reported token-class fields,
fallback ineligibility handling, SQLite result normalization, and unit/real
path tests. No tool-surface, replay, continuation/cache-prefix, or aggregation
implementation was started.

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
  M1 Work remains open for T2–T4. Derived index/views and final check are
  refreshed after lifecycle closeout.
- Targeted ESLint: 0 errors.
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

## Frozen comparison boundary

The existing #142 diagnostic result remains unchanged: Hermes/OpenCode rows
were rejected in all 12/12 evaluations and had no ranking or accepted-result
claim. #142 was not merged and was not rerun. A four-way Hermes/OpenCode,
pre-M1 Butler, and post-M1 Butler comparison is explicitly deferred until the
full M1 work is complete.

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
The recovered baseline integrity is independently approved. T2 may begin only
after the recovery phase commit and Ledger attempt/Task/views/check closeout.
This report authorizes no optimization success claim, default-on decision,
push, PR, or merge.
