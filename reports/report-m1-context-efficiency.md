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
