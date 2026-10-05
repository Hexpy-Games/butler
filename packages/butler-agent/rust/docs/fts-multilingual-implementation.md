# Multilingual FTS fallback implementation and acceptance

Latest follow-up: the coordinator adopts [Script15 as the no-embedding fallback](fts-script-experiment.md#coordinator-adoption-script15), with optional resumable re-indexing. Top-30 remains rejected, research targets remain unmet, and vectors stay primary. The results below describe the earlier neutral implementation.

2026-10-03, Linux x86_64 / WSL. **Acceptance stopped at the accuracy gate.** The implementation is available for review, but the requested three-arm judge comparison is not validated. Vectors remain the primary lane; FTS replaces an unavailable vector lane. The research does not justify enabling FTS alongside available vectors.

A subsequent [bounded offline tuning round](fts-multilingual-tuning.md) also failed its gate (66/89 original, 15/35 extra-vague in the saved-trace RRF diagnostic); no product variant was adopted.

## Native held-out run

The same fixed seed-20261003 question split was used: 124 held-out questions, including 89 original and 35 extra-vague. The snapshot is Korean-skewed (242/244 corpus questions contain Hangul); multilingual behavior is separately covered by Korean, English, Japanese, Chinese and mixed Korean/English stub E2Es. This is not a multilingual accuracy benchmark.

The research harness is absent from this branch; its read-only research worktree and saved artifacts supplied the held-out protocol. The native public-API probe (`examples/fts_recall_probe.rs`) used a disposable snapshot copy and no vector or judge port. These are **FTS plus existing lexical/graph results without judging**, not FTS+judge measurements. Candidate metrics use the first 30 ranked candidates; serialized-page metrics use the complete default six-result page. Missing gold contributes zero. Every one of the 124 full payloads was retained and checked for fields, ordering, uniqueness, counts and gold-rank arithmetic; no content was cut to reduce latency.

| Slice | n | Native candidate hit@1 / hit@5 / MRR@30 | Serialized page hit@1 / hit@5 / MRR@6 | Optimistic judge hit@5 ceiling | Research FTS+judge hit@5 |
|---|---:|---|---|---:|---:|
| keyword | 33 | 48.5% / 81.8% / 0.624 | 48.5% / 75.8% / 0.592 | 97.0% | 93.9% |
| paraphrase | 34 | 14.7% / 41.2% / 0.276 | 14.7% / 38.2% / 0.235 | 70.6% | 73.5% |
| vague | 22 | 4.5% / 27.3% / 0.143 | 4.5% / 13.6% / 0.077 | 54.5% | 63.6% |
| vague-extra | 35 | 8.6% / 17.1% / 0.142 | 8.6% / 17.1% / 0.119 | 31.4% | 45.7% |
| original | 89 | 24.7% / 52.8% / 0.372 | 24.7% / 46.1% / 0.328 | 76.4% | 78.7% |
| all | 124 | 20.2% / 42.7% / 0.307 | 20.2% / 37.9% / 0.269 | 63.7% | 69.4% |

The branch judge can only promote its first 15 candidates. Even assuming perfect choices and ignoring its conditional gate and remaining hydration failures, original hit@5 cannot exceed 68/89 = 76.4%, below the research 70/89 = 78.7%. Extra-vague cannot exceed 11/35 = 31.4%, below 16/35 = 45.7%. This is a mathematical upper bound, not a measured judge score. Further judge calls and the vectors+judge / FTS+judge / both comparison were stopped at this gate; zero live model calls were made.

An offline tokenizer probe over the research corpus, fused with the saved no-vector candidates using research RRF60, retained original recall@30 of 80.9%. It did not apply the native freshness, ranking and source hydration pipeline. That probe does not override the failed native acceptance result. No root cause for the native discovery gap, graph deadlines or remaining source failures is claimed without a matched control.

## Paired exploratory intervals

These compare native **unjudged candidate ordering** to the saved research matched always-vector judge ordering. They are not the requested same-build, same-policy three-arm comparison. The archive uses a different build, full-evidence prompt and always-judge policy; this branch retains its compact conditional judge. Paired 10,000-resample question bootstrap, seed 20261003; percentile 95% CIs. Session-cluster sensitivity and fresh matched judge intervals remain unverified.

| Slice | Historical vectors+matched judge hit@1 / hit@5 / MRR@30 | Native minus archive hit@1 pp [CI] | hit@5 pp [CI] | MRR delta [CI] |
|---|---|---|---|---|
| keyword | 69.7% / 90.9% / 0.784 | -21.2 [-39.4, -3.0] | -9.1 [-21.2, 3.0] | -0.160 [-0.288, -0.034] |
| paraphrase | 50.0% / 73.5% / 0.605 | -35.3 [-52.9, -20.6] | -32.4 [-50.0, -11.8] | -0.329 [-0.476, -0.187] |
| vague | 54.5% / 63.6% / 0.593 | -50.0 [-72.7, -31.8] | -36.4 [-59.1, -13.6] | -0.450 [-0.633, -0.268] |
| vague-extra | 60.0% / 74.3% / 0.665 | -51.4 [-68.6, -34.3] | -57.1 [-74.3, -40.0] | -0.523 [-0.663, -0.383] |
| original | 58.4% / 77.5% / 0.668 | -33.7 [-44.9, -23.6] | -24.7 [-36.0, -13.5] | -0.296 [-0.383, -0.207] |
| all | 58.9% / 76.6% / 0.667 | -38.7 [-47.6, -29.8] | -33.9 [-43.5, -24.2] | -0.360 [-0.438, -0.283] |

## Resources and remaining coverage failures

- Native recall wall median/p95: **2683.7 / 3522.1 ms**, sequential calls, no judge or vector-worker time. Standalone peak RSS: **102.4 MiB**; not whole-service RSS.
- Backfill: **2315.4 ms**, **23 batches**, at most 32 episodes per transaction; peak RSS **26.2 MiB**. All **714** indexed rows and **1791** source references were checked against current SQL, with all full content hashes recomputed. No pending rows remained.
- Added index allocation: **16,068,608 bytes (15.3 MiB)**, including FTS tables, metadata and the new indexes. Existing graph/vector storage was retained.
- **124/124 partial responses**, zero errors and zero empty pages. Codes overlap: graph ingestion_pending=112, graph_depth_limit=97, candidate_limit=11, graph_deadline=9, lexical_partial=14, identity_partial=3; source ingestion_pending=112, serialization_budget=101, source_resolution_failed=42; vectors unavailable=124. These remain in every denominator. The FTS lane rejects stale/unresolvable sources before its top-k and refills; broader graph/source failures remain unresolved.
- Original snapshot fingerprints unchanged: **2697 files**. All writes occurred on the disposable copy. Private questions, content, labels and per-call output remain outside git and run copies are deleted at completion.

## Implementation and validation

The versioned SQLite episode projection stores complete summary/entity/claim/source fields, revision, project/session/time, source references and a full content hash. Its generation is the containing graph generation. NFKC and full case folding feed Unicode word tokens and adjacent CJK character tokens, splitting mixed-script runs; there are no language stopword lists or language detection. Single-character CJK cues have indexed character tokens. Completion-consumer cache work builds the schema and advances resumable 32-episode batches under the existing consolidation lease. There is no new timer or admission dependency. Existing read-only work detection checks the pending table; the FTS index is not rebuilt or queried for content on idle probes.

FTS candidates are scope/current-revision filtered in indexed SQL, then checked against canonical spans and supersession before selecting 30. The lane uses the vector fusion slot and reports lexical provenance. Existing judge settings, gate, deadline and complete-order fallback apply. Graph-revision updates invalidate pinned prepared selections. Reset deletion triggers prune the new tables, and whole-generation inventory/cleanup includes their files.

- `cargo fmt --all`, pinned Rust 1.91 `cargo clippy -j 8 -p butler-agent -p butler-memory -p butler-e2e --all-targets --no-deps -- -D warnings`, and `cargo run -j 8 -p butler-source-check -- .`: passed. Source check: zero OS-boundary, function-size, test-policy and E2E-gate violations.
- Memory unit tests: **107 passed**. The pre-existing idle fixture now drains and asserts the new pending FTS work before checking idle polls.
- Stub E2Es: memory **22 passed** (including five multilingual remember/recall/restart/reset cases); reset **3**, idle **3**, management **3**, hot-cache **1**, wiring **4**, migration **2** passed. Wiring-more: **11 passed, 2 failed**; attribution is recorded below. Missing embedding-asset preconditions were restored for the existing vector cases. The forgetting fixture now handles the conditional judge with a typed stub response; no product gate or test assertion was weakened.
- MEM-IDLE: 60.001 s, **zero graph commits, leases and embedding workers**, unchanged files. Full-service physical reads were **96 KiB**; this does not prove zero total idle I/O. Change catch-up was 59.146 s; crash recovery observed one recovered completion and zero further writes.
- `bun install --frozen-lockfile --ignore-scripts && bun run check`: blocked because `bun` is absent on this host. No TypeScript/UI files changed.
- The native benchmark and original E2E binaries were built from the repo root with the host default Rust 1.98; final Rust validation used the workspace-pinned 1.91 from the Rust directory. Benchmark results were not regenerated after the stopped accuracy gate.

The two remaining wiring-more failures are retained as failures, without retries or weakened assertions:

- `tests/memory_rules/duration.rs:380`: project-reset inventory returns HTTP 409 `memory_operation_unavailable`. The same failure reproduced against the compatible recall-judge base (`c98146860`, document-only cherry-pick over `cd50a962a`), without FTS.
- `tests/memory_rules/crash.rs:80`: queued follow-up ends `turn_interrupted`. The same test passed on the recall-judge base (49.26 s, all seven crash stages with active plus queued turns). The FTS-run failure remains unexplained; no lifecycle/BTCC fix or claim of inherited failure is made.

An initial origin/main control could not exercise these APIs (404 / missing fixture state), so it was discarded. A fresh archived-base build also exposed stale shared Cargo artifacts; refreshing archive source mtimes rebuilt the correct platform/turn APIs. This was a build-control correction, not a product fix. No matching open GitHub issue was found for the test names; neither failure was established on main.

The required latest-main merge preserved the recall-judge access policy and semantically combined its memory-tool catalog with upstream schedule-tool changes. An initial merge resolution missed the inherited tools declaration and failed the agent build; restoring that declaration corrected the merge. Rust checks were rerun after the correction. The benchmark predates that merge; the fresh pinned Rust 1.91 agent passed all five multilingual cases (21.95 s) and all three reset cases (14.13 s) after the merge. The full E2E suite and idle measurement were not repeated after the merge.

No new dependencies or licence fingerprints were introduced, and no licence refresh was performed.

Unverified: fresh three-arm judge scores and CIs, session-cluster sensitivity, complete recall/read/answer accuracy, root causes of remaining native coverage failures, and unsupported-platform/asset-fault packaging checks. These require follow-up after the stopped accuracy gate.
