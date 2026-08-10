# M1 Context Efficiency — T1 Baseline and Telemetry Report

Date: 2026-08-10
Task: `T-M1-BASELINE-TELEMETRY`
Work: `W-M1-CONTEXT-EFFICIENCY-20260810`
Source revision: `65494154f6e9ddbfb20458bc67250c7d15b5d13d`
Flag revision: `m1-t1-v1`

## Gate result

**BLOCKED — T1 stop gate is not passed.** T2–T5 have not started.

Three pre-M1 Butler arms completed and have directly comparable delivery and
provider observations. The pre-M1 landing-page arm stopped during SQLite setup
with the bounded error `database is locked`; it produced no delivered result,
no provider usage record, and no paired baseline measurement. The corresponding
post-telemetry arm completed, but it cannot repair the missing pre-M1 pair.

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
| `landing-cold` | **gated**; setup hit `database is locked`; no delivered result, no agent request completion, no provider usage record | delivered; 16 agent requests (15 successful usage samples and 1 failed transport attempt); 274,830 ms; 1,240,943 serialized bytes; event input estimate 291,811; provider prompt 221,086 / cache read 124,928 / cache write 0 / output `null` / total 229,518; event elapsed 273,670 ms; first useful 11,030 ms; tools 16 / failures 0 | **Unpaired; blocks T1** |

The post-run events were `m1_baseline_arm_observed`, `status: ok`, `unit: arm`,
with the frozen arm metadata and `rawTextStored: false`. Missing provider output
tokens remain `null`; they were not coerced to zero. The landing event's
`modelRequests: 16` correctly includes the failed transport attempt while
provider usage totals include only successful usage samples.

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
- Landing: the post-T1 run delivered, satisfied the expected file assertions,
  reported build success, and passed the harness desktop/mobile/no-overflow
  checks plus reload matching. The pre-M1 setup failure means there is no
  accepted paired quality comparison.
- Across the completed post-T1 arms, no duplicate effect, tool failure, or
  lost-correction signal was observed. The failed pre-M1 landing arm prevents
  a whole-gate zero-regression claim.

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
- `bun run check`: the 2,531-test suite reached 2,530 pass / 1 fail. The
  unrelated existing failure is `tests/unit/butler-cli-docs.test.ts` because
  the CLI reference contains 102 documented commands while the registry
  currently exposes 101; no CLI reference or registry file is in this diff.
- Project Ledger: attempt `A-M1-T1-20260810` is failed, task
  `T-M1-BASELINE-TELEMETRY` is blocked with the landing-cold pairing reason,
  derived index/views were refreshed, and final `project-ledger check` reports
  `issueCount: 0`.
- Targeted ESLint: 0 errors.
- Windows CI was excluded per the governing decision.
- First independent gpt-5.6-sol high review: **changes required**. Findings
  were addressed: ingress timing now begins before preparation, metadata uses
  strict safe identifiers, fallback arms are ineligible, counters initialize
  at known zero, provider output is direct/nullable, the production public
  path is exercised through the real composition, and the Guided Turn file is
  below the BTCC shape limit. Final independent gpt-5.6-sol high re-review:
  **APPROVE**, no actionable findings.

## Frozen comparison boundary

The existing #142 diagnostic result remains unchanged: Hermes/OpenCode rows
were rejected in all 12/12 evaluations and had no ranking or accepted-result
claim. #142 was not merged and was not rerun. A four-way Hermes/OpenCode,
pre-M1 Butler, and post-M1 Butler comparison is explicitly deferred until the
full M1 work is complete.

## Decision

T1 telemetry implementation is ready for review, but the mandatory T1 stop
gate is **not closed** because the pre-M1 landing arm is unpaired and
unreproducible in the captured baseline. T2–T5 remain blocked. No default-on
optimization decision, success claim, push, PR, or merge is authorized by this
report.
