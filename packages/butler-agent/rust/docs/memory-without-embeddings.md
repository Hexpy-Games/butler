# Memory recall without embeddings

Measured 2026-10-03 on Linux x86_64 / WSL, SQLite 3.46.1. Research and design only; no product implementation. Only aggregate results are published. Scripts, prompts, source material, labels, permutations and raw usage remain in `/home/yeonw/workspace/bench/out/noembed/`. The immutable owner snapshot was read only. Run copies and this task's build target were deleted after validation.

## Decision

Recommend an explicit **embedding-optional fallback**, retaining the current no-vector graph/lexical/raw-BM25 candidates and adding a small episode FTS index with Korean bigram support. A schema-validated choice judge can improve recognition after retrieval. Keep question rewriting optional: it adds another model round. Keep vectors when available. This experiment does **not establish a faster or non-inferior primary replacement** for vectors plus a judge.

On the 89 held-out original questions, no-vector FTS + judge reaches 78.7% hit@5, versus 77.5% with the matched always-vector judge; paired difference 1.1 pp, 95% CI [-7.9, 10.1]. On 35 extra-vague questions the corresponding scores are 45.7% versus 74.3%. That discovery gap, partial source coverage, and the 7.51-second serial replay prevent a primary-path recommendation.

For an enabled enhanced-fallback mode, use the measured always-judge policy subject to the user's model/deadline setting; keep ordinary offline lexical recall available. The tested gate saves 20.2% of calls but loses 4.5 pp original hit@5 (95% CI [-9.0, -1.1]); do not adopt that gate as a validated quality-preserving shortcut. Rewriting is a slower optional refinement, not the default.

The important distinction is candidate discovery versus recognition. A judge cannot recover a gold episode outside its offered pool. Removing embeddings saves their resident model and download, but does not remove the graph, canonical validation, evidence hydration, or existing SQLite work. The measured fallback still uses the current graph lane; replacing that lane entirely is a separate unproven optimization.

## Protocol and boundaries

- 175 quality-filtered original questions plus 69 additional, unfiltered vague questions; 244 total, 242 containing Hangul. Keep the extra slice separate from the original score.
- Reuse the fixed question-stratified split, seed 20261003: dev 120 (32 keyword, 33 paraphrase, 21 vague, 34 extra), held out 124 (33, 34, 22, 35). Original-only held out: 89. Held-out queries cover 64 sessions and 92 distinct gold-episode sets. Related episodes/sessions cross halves; this is exploratory, not a session-disjoint confirmation set. The snapshot and original benchmark corpus were created with vectors available (gold-source selection required complete vector units); never-embedded ingestion and fresh unembedded episodes are not validated by this read-time ablation.
- All tokenizers, fields, fusion options and prompts were compared on dev. Candidate selection maximizes dev recall@30, then recall@15, then median lookup time. Final candidate choices and ranking policy were frozen before scoring held-out judgments. Earlier 240 dev judgments of simpler Unicode/trigram pools are retained as development experiments, not additional held-out evidence.
- Gold is the strict source episode, matched by SHA-256. Every gold episode exists in the indexed corpus. Repeated facts in other episodes are not relabeled as hits. These are candidate-order metrics, **not answer correctness or the final serialized product page**. Some candidates fail downstream source resolution; ranking-only scores can therefore overstate usable-evidence quality (see coverage audit). MRR is truncated at the offered 30 candidates; missing gold contributes zero.
- Paired 10,000-resample percentile bootstrap 95% intervals, seed 20261003. Original/all comparisons also have session-cluster sensitivity intervals. No multiple-comparison correction; small slices and generated cues limit inference. Historical vector controls use the same questions/snapshot, but different runs/builds; their paired intervals do not remove that confounding.
- New product no-vector run: 244 sequential B1 recalls, raw question, unchanged defaults, full payloads and candidate traces. Binary built from recall-perf `bfa424da1`, with only the observational harness main/metric sink from local `vague-src`; embedding warm-up disabled. No product source edits. Later main merge does not change this binary's provenance. Cargo used `-j 8`, one build at a time.
- Live experiments used only nested `codex exec -m gpt-6-luna`, low effort, schema-constrained JSON, ephemeral/read-only, user configuration ignored, at most four concurrent processes. Tools were forbidden and audited. The main 1,147 calls passed that audit; one later matched-control call violated it and is retained as an original-order fallback. Failed calls were not retried. Each rewrite sees only its question; write metadata sees no questions; judges see no gold or expected answer.

### Indexed material and Korean behavior

The corpus contains 714 active episodes, 1,791 current-revision public/authorized source rows, and 1,588,188 UTF-8 source bytes. The indexes contain complete stored summaries, extracted entities/aliases, claim statements and source spans. Project-bound questions use their bound project; unassigned callers retain all-user scope, matching the existing default. Source eligibility and revision filtering occur offline; the prototype does not replace canonical evidence freshness checks.

`unicode61` separates words at character-category boundaries; it is not a Korean morphological analyzer. Prefix queries help suffix attachment. FTS5 trigram MATCH cannot match a term shorter than three Unicode characters. A two-character-safe path is necessary; do not silently fall back to unindexed LIKE scans. These are documented SQLite behaviors and were checked on synthetic Korean text. [SQLite FTS5 tokenizers](https://sqlite.org/fts5.html#tokenizers).

The tested Korean index uses FTS5 unicode61 over per-field distinct NFKC/case-folded words plus adjacent Hangul bigrams encoded as single tokens. Query words use the same normalization, fixed generic stopwords and minimum length two. This is a prototype lexical expansion, not Korean linguistic stemming. No source/evidence content is truncated. The index has field weights summary/entity/claim/source = 4/2/1/0.25. The Python bigram probe filters the full MATCH result by scope before selecting 30; production must put the scope/revision predicate in the indexed SQL path.

RRF uses k=60 with deterministic ties. Each lane contributes up to 30; fusion keeps the best 30 unique episodes. The selected no-vector pool is current candidates + Korean FTS. Rewriting produces at most three sets of six Korean/English keywords; its best pool fuses that base with keyword searches against the Korean index. These bounds were fixed before held-out evaluation.

## A. Candidate discovery

Percentages below are strict gold recall. Timings cover the measured stage only; current and current+FTS include the existing full recall call, whereas FTS rows are index probes. They are not interchangeable end-to-end measurements.

| Candidate method | Dev R@30 | Held R@15 | Held R@30 | Median / p95 ms |
|---|---|---|---|---|
| u-summary | 39.2 | 35.5 | 37.9 | 0.11 / 0.21 |
| t-summary | 37.5 | 37.9 | 41.1 | 0.11 / 0.27 |
| u-fields | 52.5 | 50.8 | 55.6 | 0.18 / 0.41 |
| u-source | 54.2 | 46.0 | 46.8 | 0.13 / 0.27 |
| u-all | 52.5 | 46.0 | 54.0 | 0.15 / 0.32 |
| u-weighted | 53.3 | 44.4 | 52.4 | 0.14 / 0.38 |
| u-prefix | 56.7 | 51.6 | 57.3 | 0.21 / 0.52 |
| t-all | 43.3 | 46.8 | 53.2 | 0.15 / 0.33 |
| t-weighted | 47.5 | 46.8 | 50.8 | 0.13 / 0.31 |
| u-prefix+t-weighted | 56.7 | 54.0 | 63.7 | 0.36 / 0.80 |
| canonical-u-prefix | 56.7 | 51.6 | 58.1 | 0.20 / 0.62 |
| ko2 | 61.7 | 60.5 | 68.5 | 0.93 / 1.69 |
| current | 60.0 | 54.0 | 66.1 | 2829.97 / 3681.90 |
| current+ko2 | 62.5 | 63.7 | 71.8 | 2831.36 / 3682.73 |
| best+ko2-rewrite | 69.2 | 65.3 | 75.8 | 2832.33 / 3683.69 |

`u` denotes unicode61; `t` denotes OR-ed within-word trigrams; `fields` contains summary/entities/claims; `all` gives all four fields equal weights; `weighted` uses 4/2/1/0.25. `prefix` adds prefix matching; `canonical` uses linked public turns; `ko2` is the Korean bigram expansion. Field weights and tokenization do not add missing semantic context. Source-only, summary-only, equal-field, weighted-field, prefix, phrase-trigram and bigram variants were all retained. Expanding episode context to full eligible canonical turns yielded 1,092,319 source bytes after deduplication/eligibility differences and no dev recall@30 gain; it was not selected. This is linked-turn retrieval, not an index of the complete conversation archive.

| Slice | n | Current R@15 / R@30 | FTS-assisted R@15 / R@30 | Rewrite-assisted R@15 / R@30 |
|---|---|---|---|---|
| keyword | 33 | 87.9 / 97.0 | 93.9 / 97.0 | 93.9 / 97.0 |
| paraphrase | 34 | 58.8 / 67.6 | 64.7 / 73.5 | 67.6 / 79.4 |
| vague | 22 | 50.0 / 54.5 | 50.0 / 68.2 | 50.0 / 68.2 |
| vague-extra | 35 | 20.0 / 42.9 | 42.9 / 48.6 | 45.7 / 57.1 |
| original | 89 | 67.4 / 75.3 | 71.9 / 80.9 | 73.0 / 83.1 |
| all | 124 | 54.0 / 66.1 | 63.7 / 71.8 | 65.3 / 75.8 |

Fresh no-vector serialized-page hit@5 (the actual default six-result product page): 44.9% original-only and 36.3% including extra. Candidate-pool recall@30 is a separate metric.

The existing graph does not provide an independent semantic substitute: prior diagnosis found 97.5% of nodes confined to one episode and no useful read-time expansion gain. This experiment adds lexical episode postings; it does not claim to have repaired graph connectivity.

## B. Choice ranking and narrowing

The judge sees each full stored summary and a query-matched source window of at most 700 Unicode characters, with local integer candidate handles. This is a recognition view; original evidence and the complete result set remain available. It chooses up to ten plausible candidates. Validate range, uniqueness and schema; invalid output falls back to the complete original order. The dev-selected policy promotes the valid shortlist in judge order and appends every unlisted candidate unchanged. RRF was tested but lost on dev. No invented confidence score is used.

Always and gated variants reuse the same valid judgments. The frozen gate is relative absolute BM25 margin between the first two Unicode-prefix results <0.30; fewer than two results bypass. It is an experimental lexical ambiguity gate, not the historical vector judge's score threshold.

Values are hit@1 / hit@5 (%) / MRR@30, all held out.

| Slice | n | Vectors | Vectors + historical gated judge | Vectors + matched always judge | No vectors + FTS + judge | No vectors + rewrite + judge |
|---|---|---|---|---|---|---|
| keyword | 33 | 63.6 / 90.9 / 0.740 | 63.6 / 90.9 / 0.742 | 69.7 / 90.9 / 0.784 | 66.7 / 93.9 / 0.775 | 66.7 / 90.9 / 0.763 |
| paraphrase | 34 | 38.2 / 73.5 / 0.522 | 44.1 / 76.5 / 0.556 | 50.0 / 73.5 / 0.605 | 44.1 / 73.5 / 0.545 | 44.1 / 73.5 / 0.562 |
| vague | 22 | 13.6 / 36.4 / 0.257 | 31.8 / 54.5 / 0.411 | 54.5 / 63.6 / 0.593 | 50.0 / 63.6 / 0.535 | 59.1 / 63.6 / 0.619 |
| vague-extra | 35 | 20.0 / 45.7 / 0.305 | 31.4 / 62.9 / 0.427 | 60.0 / 74.3 / 0.665 | 40.0 / 45.7 / 0.426 | 45.7 / 54.3 / 0.490 |
| original | 89 | 41.6 / 70.8 / 0.537 | 48.3 / 76.4 / 0.589 | 58.4 / 77.5 / 0.668 | 53.9 / 78.7 / 0.628 | 56.2 / 77.5 / 0.651 |
| all | 124 | 35.5 / 63.7 / 0.472 | 43.5 / 72.6 / 0.543 | 58.9 / 76.6 / 0.667 | 50.0 / 69.4 / 0.571 | 53.2 / 71.0 / 0.605 |

| Held-out policy | Original hit@5 | All hit@1 | All hit@5 | All MRR |
|---|---|---|---|---|
| best | 59.6 | 21.8 | 49.2 | 0.322 |
| best-judge | 78.7 | 50.0 | 69.4 | 0.571 |
| best-gated | 74.2 | 44.4 | 66.1 | 0.523 |
| bestrew | 60.7 | 26.6 | 50.8 | 0.378 |
| bestrew-judge | 77.5 | 53.2 | 71.0 | 0.605 |
| bestrew-gated | 73.0 | 49.2 | 67.7 | 0.573 |
| narrow-judge | 60.7 | 37.9 | 55.6 | 0.450 |

Paired hit@5 changes versus the historical vector + gated-judge control (percentage points, 95% CI):

| Slice | FTS + judge delta [CI] | Rewrite + judge delta [CI] |
|---|---|---|
| keyword | 3.0 [-6.1, 12.1] | 0.0 [-9.1, 9.1] |
| paraphrase | -2.9 [-14.7, 8.8] | -2.9 [-14.7, 5.9] |
| vague | 9.1 [-9.1, 27.3] | 9.1 [-13.6, 31.8] |
| vague-extra | -17.1 [-34.3, 0.0] | -8.6 [-25.7, 8.6] |
| original | 2.2 [-5.6, 10.1] | 1.1 [-6.7, 9.0] |
| all | -3.2 [-10.5, 4.0] | -1.6 [-8.9, 5.6] |

**Matched-policy control:** the old gated/RRF reference is not an equal-judging comparison. After freezing the no-vector policy, 124 additional held-out vector-pool calls used the identical full-evidence prompt, shortlist policy and always-judge schedule. This added control was not used for tuning and keeps the live-call bound below 1,292. One of 124 calls used prohibited web search; its judgment was discarded and the original vector order retained. The other 47 calls not yet attempted when that batch stopped used web search explicitly disabled. This mixed runner configuration and the one failure are additional control limitations. Candidate vectors are still from saved traces, so build/time confounding remains.

| Slice | FTS + judge minus matched vector judge pp [CI] | Rewrite + judge minus matched vector judge pp [CI] |
|---|---|---|
| keyword | 3.0 [-6.1, 12.1] | 0.0 [-9.1, 9.1] |
| paraphrase | 0.0 [-14.7, 14.7] | 0.0 [-11.8, 11.8] |
| vague | 0.0 [-22.7, 22.7] | 0.0 [-18.2, 18.2] |
| vague-extra | -28.6 [-45.7, -11.4] | -20.0 [-37.1, -2.9] |
| original | 1.1 [-7.9, 10.1] | 0.0 [-6.7, 6.7] |
| all | -7.3 [-15.3, 0.8] | -5.6 [-12.9, 1.6] |

Other paired original-only comparisons:

| Change | Hit@5 delta pp [CI] | MRR delta [CI] |
|---|---|---|
| current-candidates -> best | 12.4 [3.4, 21.3] | 0.017 [-0.033, 0.067] |
| best -> bestrew | 1.1 [-6.7, 7.9] | 0.056 [0.009, 0.103] |
| best -> best-judge | 19.1 [11.2, 28.1] | 0.236 [0.160, 0.313] |
| best-judge -> bestrew-judge | -1.1 [-5.6, 3.4] | 0.023 [-0.019, 0.073] |
| best-judge -> best-gated | -4.5 [-9.0, -1.1] | -0.059 [-0.110, -0.014] |
| best-judge -> narrow-judge | -18.0 [-25.8, -10.1] | -0.158 [-0.235, -0.086] |

Session-cluster sensitivity for original-only hit@5 versus vector+judge: FTS [-6.0, 8.5] pp; rewrite [-6.1, 7.0] pp. Full intervals for hit@1, hit@5, R@15/30 and MRR are in private `paired-ci.json`.

### Structured narrowing

The question-only call also returns an explicit project name or null, calendar bounds or null, and one activity choice (coding/research/planning/personal/unknown). Episode activity labels come from the question-blind write experiment. Filter the base 30 by these choices; an empty filter falls back to the base pool. Judge the reduced pool, then append excluded base candidates so final output membership is preserved. Unchanged pools reuse the identical base judgment.

Held out: 50/124 changed pools, 1 empty-filter fallbacks, 21.2 candidates offered on average. Explicit project fields: 0; explicit calendar fields: 0. Offered-pool recall@30 is 54.0%, versus 71.8% before narrowing.

There were no explicit calendar bounds in this benchmark, so calendar-filter effectiveness remains unmeasured. This is a functional simulation of narrowing, not a measurement of a separate cheap facet endpoint: facets share the rewrite call, and its full tokens/time are charged. Unknown dates are not invented. Exact-session filters are useful only for an explicit session reference, not an inferred activity. Hard scope limits remain authority constraints; inferred context must not widen them. Prefer soft boosts unless an independently validated filter preserves recall.

## C. Write-side help

All 714 episodes received question-blind metadata in 72 batches of at most ten: at most 12 Korean/English keywords/aliases plus an activity tag, based on full stored summaries and extracted entities. No gold targeting or episode sampling. These tags are derived retrieval hints, not authoritative facts. Translation/grounding quality was not separately human-audited.

| Write/structural variant | Dev R@30 | Held R@15 | Held R@30 | Held hit@5 |
|---|---|---|---|---|
| u-prefix+t-weighted | 56.7 | 54.0 | 63.7 | 40.3 |
| write-fused | 56.7 | 54.8 | 64.5 | 39.5 |
| ko2 | 61.7 | 60.5 | 68.5 | 44.4 |
| write-ko2 | 62.5 | 60.5 | 70.2 | 45.2 |
| session-boost | 56.7 | 54.8 | 63.7 | 42.7 |
| session-hard | 44.2 | 43.5 | 45.2 | 39.5 |
| day-boost | 56.7 | 56.5 | 63.7 | 40.3 |
| day-hard | 45.0 | 46.8 | 47.6 | 37.9 |

Paired held-out Korean-index recall@30 change from added keywords: 1.6 pp, 95% CI [0.0, 4.0] pp.

Standalone extraction cost: 1,306,216 API input tokens (691,968 cached), 48,201 output tokens; amortized 1829.4 input and 67.5 output tokens per episode. Batch wall median/p95 17.43/27.53 s. These include Codex wrappers; adding fields to an existing extraction call could reuse its input, but incremental output/cost and grounding need measurement.

Session/day experiments concatenate all current summaries/entities into 155 session and 102 day/project rollups (3.61 MB), then boost or filter the base pool. They cost zero model tokens. They are lexical rollup proxies, **not newly generated semantic session/day summaries**. True semantic rollups and cross-episode relationship extraction remain unmeasured. No full-corpus query-time scan belongs in the product.

## D. End-to-end design comparison

| Design | Original held hit@5 | Extra held hit@5 | Latency evidence | Model calls/recall |
|---|---|---|---|---|
| 1. Vectors + optional judge | 76.4 gated; 77.5 always | 62.9 gated; 74.3 always | Historical local 3.29 s median; +4.08 s median when full-evidence judge fires | 44/124 historical gate |
| 2. No vectors + existing lexical/graph + FTS + judge | 78.7 | 45.7 | Serial replay median/p95 7.51/9.72 s | 1 always; gated variant measured |
| 3. No vectors + rewriting + judge | 77.5 | 54.3 | Serial replay median/p95 12.88/17.37 s | 2 |
| 4. Optional vectors; explicit fallback | Design 1 when present; design 2 absent | Same branch-conditional scores | Branch composition; not an integrated measurement | Configured branch policy |

Serial replay sums each question's measured no-vector call/index time and independent model calls. It is not service end-to-end latency: it excludes integration/transport changes, and a future direct decision endpoint could have different overhead. Concurrent offline throughput is never divided by four to claim per-recall latency. Historical local timings include shared-host/deadline effects and are not same-run speed comparisons.

| Held-out policy | Model wall median/p95 s | Serial replay median/p95 s | Mean API input / cached / output tokens | Mean calls |
|---|---|---|---|---|
| best-always | 4.53 / 7.61 | 7.51 / 9.72 | 27663 / 13514 / 25 | 1.00 |
| best-gated | 4.33 / 6.81 | 7.09 / 9.64 | 22192 / 10882 / 20 | 0.80 |
| rewrite-always | 10.10 / 14.05 | 12.88 / 17.37 | 40706 / 26415 / 96 | 2.00 |
| narrow | 10.36 / 14.27 | 13.26 / 17.17 | 37823 / 26515 / 93 | 2.00 |

Matched always-vector judge alone: median/p95 4.42/7.38 s; mean API input/cached/output 25136/11669/28 tokens. This is the same offered-view and judge contract as no-vector always.

Token counts are actual `turn.completed.usage`, including the substantial Codex system/schema wrapper. Cached input is a subset of input, not additional tokens. These are not minimal decision-API prompt sizes or a price quote. Budget money using actual uncached-input, cached-input and output rates. The reference compact top-15/150-character judge (~1.2k input tokens, ~4 s) is a different prompt experiment; its accuracy/cost must not be assigned to these full-evidence judgments.

| Property | Vectors + optional judge | No embeddings + FTS/judge | No embeddings + rewrite/judge | Optional-vector hybrid |
|---|---|---|---|---|
| Memory | Prior measured worker ~1.1–2.1 GB while loaded | Worker absent; FTS cache budget is separate | Same local index plus transient model calls | Worker only when vector path used |
| Disk | Model assets 586.78 MB; existing Lance 144.78 MB | Adds 9.84 MB Korean index; graph retained | Same index; query rewrites need not persist | Index plus optional vector assets |
| Graph | 1,629.82 MB; alias postings 1,423.09 MB | Unchanged until separate alias-index migration | Unchanged | Unchanged |
| Idle | Current worker exits after ~60 s; event-driven batches | No embedding work; index updates on changes | Same; no idle rewriting | Current batch policy only when enabled |
| Offline | Local vectors/lexical work; remote judge may not | Local lexical/FTS works; remote judge unavailable | Local FTS only; rewrite and judge unavailable | Best available local path; explicit coverage |
| Privacy | Local retrieval; offered evidence sent if judge enabled | Question + candidate evidence to configured model | Question first, then candidate evidence | Same branch-specific exposure |
| Complexity | Existing system plus optional judge | Versioned FTS projection, fusion, safe judge fallback | Adds rewrite/facet round, budgets and invalid-output handling | Capability/configuration and readiness states; most branches |
| Migration | No vector removal | Backfill index from current SQL; atomic switch; retain source graph | Same; optional query metadata is ephemeral | Vector absence must not block non-vector serving |

The synthetic idle SQLite probe recorded 30.0 s, 0 SQL statements, 0 storage-read bytes, 0 storage-write bytes, and 0.000034 CPU seconds. Python peak RSS was 19.1 MiB. This is an idle index probe, not a Butler service RSS/idle measurement. Index caches were limited to 8 MiB per connection in probes; production memory has not been measured.

One separate no-vector native-harness RSS probe (largest observed candidate pool, selected without gold) peaked at 95.9 MiB for 128 candidates and a complete 16,427-byte JSON response. This is one standalone benchmark process, not total Butler-service memory, and does not prove the peak for all workloads.

The standalone Unicode/trigram pair occupies 16.57 MB after VACUUM (22.65 MB before compaction); Korean bigrams occupy 9.84 MB. None is a drop-in replacement for every alias/identity/graph operation. Removing model assets and this generation's Lance data could free about 731.56 MB only after an explicit mode/migration choice; this task deleted neither from the snapshot. See [recall performance profile](recall-performance-profile.md) and [event-driven embedding lifetime](embedding-schedule.md) for the historical timing and worker measurements.

## Recommended implementation tasks and acceptance checks

1. **Explicit capability mode.** Support embedding available, deliberately disabled, and unavailable with reason. Non-vector extraction/recall must progress without a download, ORT load or embedding worker. Unsupported platforms also need install/build packaging that does not require the native embedding library; a runtime fallback alone cannot fix an installation prerequisite. Test absent/corrupt assets, denied download, disk exhaustion, memory failure and unsupported platform with stubs/replays. Pending optional vectors must not strand serving readiness or retry forever. Preserve current event-driven batching when enabled.
2. **One versioned lexical projection.** Coordinate with the alias-index redesign. Store episode ID, source revision, generation, project/session/time and full source references; use the tested Korean-aware normalization and field schema as a starting point. Backfill all eligible rows, validate counts and hashes, switch atomically, retain rollback. Test update, deletion, supersession, language normalization and two-character Korean queries. Do not delete the graph or alias system on the evidence of this benchmark.
3. **Scoped candidate union.** Preserve the existing no-vector path during rollout, add FTS candidates, deduplicate by episode, and validate current sources before offering a pool. Scope must precede top-k; stale/disallowed matches must not consume the quota without refill. Use indexed predicates and blocking-worker SQLite access. Test broad questions, restrictive scopes, stale generations and concurrent writes; assert exact counts, order and newest content alongside every timed performance check.
4. **Optional typed judge.** Use the user's configured model/provider and existing privacy/deadline policy; future dedicated decision APIs remain an owner choice. Bind local handles to this exact scoped generation. Validate every handle; malformed/duplicate/foreign output, timeout or model absence returns the complete original order. Keep full evidence/read handles and response fields. Replay always/gated behavior, empty pools, injection-like evidence, cancellation and configuration changes. Remove tools from the judge request at configuration/API level rather than relying on a prompt prohibition; the matched-control violation demonstrates why. Preserve existing deadlines and performance budgets.
5. **Optional query rewrite/facets.** Question-only, bounded sets, no expected answer or historical source text. Keep explicit lexical cues available; translations are retrieval hints, never new facts. Inferred project/time/activity should normally boost rather than exclude; null is mandatory when unknown. A genuinely choice-only API cannot generate arbitrary synonyms: it needs a supplied vocabulary/ontology or a separate generative rewrite capability. Test both unknown facets and confidently wrong facets.
6. **Defer broad write-side expansion.** This keyword experiment provides little evidence for an unconditional extra model pass. If piggybacked on existing extraction, measure incremental tokens and audit bilingual grounding. Evaluate true session/day semantic summaries on a fresh session-disjoint set before adding their invalidation/storage cost. Track provenance and revision for every derived tag.
7. **Integrated acceptance run.** Stub/replay first; then a separately authorized bounded benchmark of the complete recall/read/answer path at owner scale, including recent unembedded facts, cold/warm calls, memory, disk and idle behavior. Preserve all evidence/content and report every deadline/empty-page failure. Do not obtain speed by dropping fields, candidates or currentness checks. Require per-slice paired intervals and session-cluster sensitivity; agree on an accuracy non-inferiority margin and model-call latency/cost budget before considering a primary switch.

## Open owner decisions and work not done

- Primary-path accuracy tolerance and latency budget: the stand-in's several-second model rounds do not establish a small decision endpoint's speed, price, privacy or availability. No JEV/future Decisions API was called.
- Whether users prefer automatic configured-model judging, an explicit recall-quality option, or entirely offline lexical results. Remote judgment must not silently bypass the user's model/privacy setting.
- Whether the small dev advantage of keeping the existing candidate lane justifies its seconds of fixed work. Pure FTS plus a judge on the *final selected Korean pool* was not separately judged end to end; removal of the current lane needs that ablation and canonical freshness validation.
- Diagnosis of source-resolution failures/graph deadlines, larger independent real-cue evaluation, cross-platform measurements, answer correctness, whole-archive FTS scaling, genuinely semantic session/day summaries and integrated product implementation remain undone. This is a design deliverable, not production acceptance.
- Exact scope/metadata migrations must be reconciled with current main and the concurrent alias-index work. The old research binary and saved vector controls are explicitly historical.

## Validation and reproduction

- Existing harness structural verifier: 244 complete JSON arm records, payload byte counts, ordering, gold-rank arithmetic and synthetic metric checks passed. Snapshot and sealed-copy fingerprints unchanged. Product failures retained: 0 errors, 0 empty pages, 0 payloads over 24 KiB; maximum payload 24,556 bytes.
- Private validation: 9,760 candidate rows, scope/uniqueness/membership preservation, all gold present, four synthetic Korean tokenizer assertions. 1,147 main-experiment Luna calls valid; zero tool calls; 141 narrowing calls reused identical pools. Full raw usage remains private.
- **Coverage-quality gate not met:** all 244 responses are partial, beyond the intentionally unavailable vector lane. Graph codes: ingestion_pending=218, graph_depth_limit=154, candidate_limit=11, graph_deadline=49, lexical_partial=37, identity_partial=5. Source codes: ingestion_pending=218, serialization_budget=187, source_resolution_failed=77. Codes overlap; they are not additive failure counts. All samples remain in timing and accuracy denominators. Canonical source-resolution causes were not diagnosed here. Snapshot hash/current-revision checks do not establish that every candidate can hydrate into valid evidence. No speed or primary-path acceptance claim is based on these partial responses.
- Total bounded experiment: 1,271 live calls, 1,270 valid, 1 invalid; 29,131,038 input tokens (16,289,024 cached) and 90,022 output tokens.
- Matched control: 124 additional calls, 123 valid and one prohibited web-search call. The strict no-tools validator fails for that call; it is not reported green. The failed judgment is excluded from ranking use but its question, fallback order, wall time and usage remain in all denominators. No failed call was repeated. The runner now uses `-c web_search="disabled"`, which removes the tool according to [official OpenAI documentation](https://learn.chatgpt.com/docs/config-file/config-reference). The observed original runner is retained separately; only the 47 previously unattempted calls used the hardened runner.
- `cargo build --manifest-path benchmarks/real-recall/Cargo.toml --bin butler-real-recall-bench -j 8`: passed; the temporary harness emitted one expected unused-warmup warning. Harness changes were restored; private copies retained under `out/noembed/harness/`.
- Isolated `cargo fmt --all` and `cargo run -j 8 -p butler-source-check -- .`: passed, zero source/architecture/E2E-gate violations. Private Python compilation also passed. No product Rust/TS changes, so no touched-crate Clippy or UI test suite applies. Validation found and corrected a synthetic FTS table/column name collision. Raw product-page IDs were normalized to the trace hash domain and independently checked against the harness gold ranks; retrieval, model outputs and frozen policies were unchanged. The initial analysis script required unavailable NumPy; it was replaced with a standard-library bootstrap before analysis, without changing results or retrying model calls.
- Reproduction order: `setup.py`, `retrieve.py`, `korean.py`, `canonical.py`, `structural.py`; traced B1 harness; `model_run.py` for dev rewrite/rank/write; `variants.py`, `best.py`, `write_side.py`, `keyword_effect.py`; freeze dev choices; held-out rewrite/rank/narrow; `final_analyze.py`, `costs.py`, `validate.py`, aggregate report and this renderer. `protocol.json` and frozen choice JSONs record exact choices; all persisted per-call artifacts support independent rescoring.
