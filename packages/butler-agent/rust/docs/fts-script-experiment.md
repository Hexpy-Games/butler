# Per-script index and fallback top-30 judge experiment

2026-10-03, Linux x86_64 / WSL. **Stopped at the accuracy gate; no product change adopted.**

Recovered merge `d2693fb32`, including recall-judge E2E fixes at `5f56d394d`.
The owner permits script-specific same-language retrieval; cross-language matching is not required.
The frozen per-script analyzer won development selection, but the larger judge pool did not meet acceptance.

Protocol: unchanged seed-20261003 stratified split, 120 dev / 124 held out; strict episode-hash gold.
Select by dev recall@30, recall@15, then index lookup median; preserve dev keyword hit@5 and recall@15.
Complete native summary/entity/claim/source fields for all 714 episodes were independently checked
against the neutral analyzer before constructing the per-script index on a second disposable copy.
Every development top-30 lookup equaled its complete unlimited ordered SQL reference.
The Unicode Script analyzer and all choices were frozen before held-out retrieval/scoring.

Development neutral retrieval reused the prebuilt probe in the matching merge worktree;
both held-out probes were newly built with pinned Rust 1.91.0. This dev build difference is a limitation.
The vector control uses saved A1 candidate traces from the recall-judge benchmark, with fresh judging here;
it is not a same-build vector retrieval comparison. No historical judgments were reused.

All four fresh arms use openai/gpt-6-luna, low effort, the approved product instructions,
stored summary prefixes of 150 Unicode characters, no excerpts, unchanged gate and RRF60.
Gate: rank-one raw lexical score <0.15 AND top-two combined-score gap <0.05; fewer than two bypass.
Validate at most ten distinct local handles; preserve complete membership and every untouched tail.
Four concurrent CLI jobs at most; 8-second wall deadline; no failed-call retries or gate/prompt tuning.
The three deadline failures retain their full original orders in every accuracy/latency denominator.

Values measure candidate ordering, not final serialized pages, canonical jumps or answer correctness.
Both native held-out arms retained 124/124 partial responses; existing graph/source coverage failures
are not removed from denominators. Related sessions cross the halves; this is exploratory evidence.

## A. Frozen development selection

| Slice | n | Neutral top15 / top30 | Per-script top15 / top30 |
| --- | --- | --- | --- |
| keyword | 32 | 30 / 31 | 30 / 31 |
| paraphrase | 33 | 18 / 20 | 20 / 20 |
| vague | 21 | 6 / 7 | 7 / 7 |
| vague-extra | 34 | 13 / 16 | 12 / 17 |
| original | 86 | 54 / 58 | 57 / 58 |
| all | 120 | 67 / 74 | 69 / 75 |

Keyword unjudged hit@5 stayed 27/32 in both arms; its top-15 ceiling stayed 30/32.
Per-script won 75/120 versus 74/120 recall@30, and 69 versus 67 recall@15.
Dev index-only lookup medians: neutral 0.960 ms, per-script 0.990 ms. No production speed claim.

## A and B. Held-out candidate ceilings

| Slice | n | Neutral top15 / top30 | Per-script top15 / top30 | Conditional per-script30 ceiling |
| --- | --- | --- | --- | --- |
| keyword | 33 | 32 / 32 | 32 / 32 | 29 |
| paraphrase | 34 | 24 / 27 | 25 / 27 | 16 |
| vague | 22 | 11 / 15 | 11 / 15 | 12 |
| vague-extra | 35 | 13 / 16 | 14 / 17 | 11 |
| original | 89 | 67 / 74 | 68 / 74 | 57 |
| all | 124 | 80 / 90 | 82 / 91 | 68 |

Top-30 discovery reaches 74/89 original and 17/35 extra with per-script.
Under the unchanged gate, a perfect judge can reach only **57/89 and 11/35**:
bypassed questions cannot promote their lower candidates. This is a mathematical upper bound,
not a new ranking policy or a measured model score. Widening this gate was not authorized or attempted.

## Fresh judged comparison

Cells are hit@1 % / hit@5 % / MRR@30; missing gold contributes zero.

| Slice | n | baseline15 | script15 | script30 | vectors15 |
| --- | --- | --- | --- | --- | --- |
| keyword | 33 | 48.5 / 81.8 / 0.621 | 54.5 / 87.9 / 0.663 | 54.5 / 87.9 / 0.663 | 63.6 / 90.9 / 0.740 |
| paraphrase | 34 | 20.6 / 41.2 / 0.306 | 17.6 / 47.1 / 0.310 | 17.6 / 47.1 / 0.305 | 41.2 / 70.6 / 0.521 |
| vague | 22 | 22.7 / 40.9 / 0.299 | 18.2 / 40.9 / 0.275 | 18.2 / 50.0 / 0.296 | 27.3 / 50.0 / 0.394 |
| vague-extra | 35 | 11.4 / 25.7 / 0.187 | 8.6 / 22.9 / 0.165 | 11.4 / 25.7 / 0.193 | 20.0 / 60.0 / 0.361 |
| original | 89 | 31.5 / 56.2 / 0.421 | 31.5 / 60.7 / 0.432 | 31.5 / 62.9 / 0.436 | 46.1 / 73.0 / 0.571 |
| all | 124 | 25.8 / 47.6 / 0.355 | 25.0 / 50.0 / 0.357 | 25.8 / 52.4 / 0.367 | 38.7 / 69.4 / 0.512 |

### baseline15->script15

Paired percentile 95% change CIs; 10,000 resamples, seed 20261003.

| Slice | Hit@1 delta CI (pp) | Hit@5 delta CI (pp) | MRR delta CI |
| --- | --- | --- | --- |
| keyword | [0.0, 15.2] | [0.0, 15.2] | [-0.001, 0.106] |
| paraphrase | [-8.8, 0.0] | [0.0, 14.7] | [-0.036, 0.038] |
| vague | [-13.6, 0.0] | [0.0, 0.0] | [-0.072, 0.001] |
| vague-extra | [-8.6, 0.0] | [-8.6, 0.0] | [-0.075, 0.007] |
| original | [-4.5, 4.5] | [1.1, 9.0] | [-0.015, 0.041] |
| all | [-4.0, 2.4] | [-0.8, 5.6] | [-0.023, 0.026] |

Session-cluster sensitivity (same three metrics):

| Slice | Hit@1 CI (pp) | Hit@5 CI (pp) | MRR CI |
| --- | --- | --- | --- |
| keyword | [0.0, 15.6] | [0.0, 15.6] | [-0.001, 0.109] |
| paraphrase | [-9.4, 0.0] | [0.0, 15.6] | [-0.038, 0.038] |
| vague | [-15.0, 0.0] | [0.0, 0.0] | [-0.075, 0.000] |
| vague-extra | [-9.7, 0.0] | [-9.7, 0.0] | [-0.081, 0.007] |
| original | [-4.6, 4.7] | [1.0, 9.7] | [-0.016, 0.041] |
| all | [-4.5, 2.7] | [-0.9, 6.3] | [-0.025, 0.026] |

### script15->script30

Paired percentile 95% change CIs; 10,000 resamples, seed 20261003.

| Slice | Hit@1 delta CI (pp) | Hit@5 delta CI (pp) | MRR delta CI |
| --- | --- | --- | --- |
| keyword | [0.0, 0.0] | [0.0, 0.0] | [0.000, 0.000] |
| paraphrase | [0.0, 0.0] | [0.0, 0.0] | [-0.015, 0.000] |
| vague | [0.0, 0.0] | [0.0, 22.7] | [0.000, 0.055] |
| vague-extra | [0.0, 8.6] | [0.0, 8.6] | [-0.000, 0.082] |
| original | [0.0, 0.0] | [0.0, 5.6] | [-0.004, 0.012] |
| all | [0.0, 2.4] | [0.0, 5.6] | [-0.001, 0.028] |

Session-cluster sensitivity (same three metrics):

| Slice | Hit@1 CI (pp) | Hit@5 CI (pp) | MRR CI |
| --- | --- | --- | --- |
| keyword | [0.0, 0.0] | [0.0, 0.0] | [0.000, 0.000] |
| paraphrase | [0.0, 0.0] | [0.0, 0.0] | [-0.013, 0.000] |
| vague | [0.0, 0.0] | [0.0, 17.9] | [0.000, 0.040] |
| vague-extra | [0.0, 9.7] | [0.0, 9.7] | [-0.000, 0.089] |
| original | [0.0, 0.0] | [0.0, 4.9] | [0.000, 0.008] |
| all | [0.0, 2.8] | [0.0, 5.0] | [0.001, 0.028] |

### vectors15->script30

Paired percentile 95% change CIs; 10,000 resamples, seed 20261003.

| Slice | Hit@1 delta CI (pp) | Hit@5 delta CI (pp) | MRR delta CI |
| --- | --- | --- | --- |
| keyword | [-21.2, 3.0] | [-15.2, 9.1] | [-0.182, 0.014] |
| paraphrase | [-38.2, -8.8] | [-41.2, -5.9] | [-0.337, -0.104] |
| vague | [-27.3, 9.1] | [-22.7, 22.7] | [-0.240, 0.041] |
| vague-extra | [-22.9, 5.7] | [-51.4, -17.1] | [-0.289, -0.044] |
| original | [-23.6, -6.7] | [-20.2, 0.0] | [-0.204, -0.069] |
| all | [-20.2, -5.6] | [-25.8, -8.1] | [-0.205, -0.085] |

Session-cluster sensitivity (same three metrics):

| Slice | Hit@1 CI (pp) | Hit@5 CI (pp) | MRR CI |
| --- | --- | --- | --- |
| keyword | [-22.6, 3.2] | [-17.2, 10.0] | [-0.183, 0.011] |
| paraphrase | [-38.2, -10.0] | [-43.8, -5.3] | [-0.346, -0.100] |
| vague | [-17.9, 0.0] | [-18.8, 18.8] | [-0.165, -0.015] |
| vague-extra | [-23.5, 5.7] | [-51.4, -17.1] | [-0.285, -0.052] |
| original | [-22.0, -7.7] | [-21.8, 0.0] | [-0.196, -0.084] |
| all | [-19.7, -6.3] | [-27.7, -7.6] | [-0.199, -0.095] |

## Cost, latency and gate

Triples below are median / p95. Latency includes every gated call.

| Arm | Gate /124 | Fallbacks | Payload input estimate | Actual API input | API cached input | API output | Wall s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline15 | 27 | 0 | 1119.00 / 1273.10 | 12261.00 / 12415.10 | 8960.00 / 11008.00 | 20.00 / 26.80 | 4.07 / 5.57 |
| script15 | 30 | 3 | 1178.50 / 1283.35 | 12316.50 / 12423.05 | 8960.00 / 11008.00 | 20.00 / 25.30 | 4.33 / 8.00 |
| script30 | 30 | 0 | 2224.00 / 2358.05 | 13362.00 / 13496.05 | 8960.00 / 8960.00 | 22.00 / 34.00 | 3.98 / 5.87 |
| vectors15 | 44 | 0 | 1099.00 / 1282.20 | 12239.00 / 12441.85 | 8960.00 / 11008.00 | 22.00 / 28.00 | 4.07 / 6.38 |

Fallback gate fires **less**: per-script 30/124 (24.2%), neutral 27/124 (21.8%),
versus vectors 44/124 (35.5%). Candidate count does not alter the frozen gate.
Actual API input includes the Codex wrapper and cached tokens; cached input is never subtracted.
Payload estimates use tiktoken 0.14.0 o200k_base; model mapping and role/schema framing are unverified.
API usage is available for 129/131 calls, including one discarded completed deadline call;
two killed calls have unknown billable usage. Actual token distributions use reported calls only.
131 live calls: 128 valid rankings, 3 deadline fallbacks, zero tool calls. No monetary price claimed.

## Decision and remaining work

**Reject adoption.** Per-script30 hit@5 is 56/89 original and 9/35 extra, below 70/89 and 16/35.
It gains three hits over per-script15, with no hit@5 losses, but overall delta CI [0.0, 5.6] pp
includes zero. Original delta CI is [0.0, 5.6] pp; extra [0.0, 8.6] pp. Keyword is unchanged.
MRR delta CI also includes zero [-0.001, 0.028]. Judge p95 5.87 s passes the 8 s deadline.
Neither the absolute targets nor a CI-supported improvement pass; no further tuning or calls.
Product tokenizer, judge count 15, 150-character summaries and existing work-path behavior remain unchanged.
Consequently product per-script adoption, resumable re-index changes, top-30 wiring,
new German/French and Chinese E2Es, and stub coverage of both counts are not implemented.

Reproduction: [benchmarks/fts-script](../benchmarks/fts-script/README.md).
The temporary native query bridge was reversed before product checks; only benchmark code is committed.
Immutable graph/canonical/corpus input fingerprints are verified unchanged before cleanup.
Private run copies, prompts, index/order artifacts, Python bytecode and task target are deleted at completion.

## Validation

All checks/tests used fresh HOME and BUTLER_DATA, retained real Cargo/Rustup caches,
`cargo -j 8`, one build at a time, and at most four E2E test threads.

- Pinned Rust 1.91.0: baseline probe, experimental probe and agent builds passed.
- `cargo fmt --all`: passed. `cargo clippy -j 8 -p butler-agent -p butler-memory
  -p butler-e2e --all-targets --no-deps -- -D warnings`: passed.
- `cargo run -j 8 -p butler-source-check -- .` from the Rust workspace: passed,
  zero architecture/platform/test-policy/E2E-gate violations.
- Stub memory: initial invocation **18 passed / 4 failed**, all four at the
  required local-embedding-asset setup assertion. The omitted environment variable
  `BUTLER_E2E_EMBEDDING_ASSETS` was restored to the immutable benchmark BGE-M3 cache.
  Actual vector-batch behavior then **3 passed** (serial, 116.16 s), and the
  instruction-vector reset behavior **1 passed** (13.21 s). The initial failures
  remain recorded; no unexplained/flaky failure was retried or assertion weakened.
- Stub memory_reset **3 passed** (5.52 s), memory_idle **3 passed** (73.11 s),
  memory_wiring **4 passed** (4.12 s), memory_rules through memory_wiring_more
  **13 passed** (73.08 s), including project reset and active plus queued shutdown/crash recovery.
- An initial command named nonexistent Cargo target `memory_rules`; no test ran.
  It was corrected to the existing `memory_wiring_more` target.
- An initial probe fixture had no synthetic caller bindings and returned
  `invalid_scope`; those results were discarded before any scoring. Restoring
  the saved benchmark canonical caller store on the disposable copy fixed it.
  All 488 valid dev/held-out native recalls succeeded; complete payloads/orders
  and index fields were retained during measurement.
- Python syntax, aggregate/permutation/tool audits, immutable input fingerprints
  and isolated `git diff --check`: passed. No TypeScript/UI or new product dependency.
- No product re-index/count/analyzer change or new E2E was made after the failed gate.
  No PR requested. Push is restricted to `codex/fts-multilingual`.
