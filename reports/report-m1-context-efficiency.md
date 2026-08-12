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
