# Bounded multilingual FTS improvement round

Latest follow-up: [per-script index and fallback top-30 experiment](fts-script-experiment.md) stopped at its accuracy gate; neither product change was adopted.

2026-10-03, Linux x86_64 / WSL. **Stopped at the offline accuracy gate. No product variant adopted.** One fixed development grid, one frozen choice, one held-out evaluation. No Cargo builds, E2Es or model calls were made. The existing multilingual implementation is unchanged.

## Protocol and limits

Read the [implementation acceptance](fts-multilingual-implementation.md) and [research protocol](memory-without-embeddings.md) first. Reused seed 20261003: dev 120 (32 keyword, 33 paraphrase, 21 vague, 34 extra-vague); held out 124 (33, 34, 22, 35). Selection maximizes dev recall@30, then recall@15, then median index lookup time. A variant must also preserve both keyword hit@5 and recall@15 on dev. Only the frozen winner and baseline were evaluated on held out. No other held-out variant scores were inspected or used for selection.

The prior native per-question traces and prototype outputs were deleted by the previous task's cleanup. The documented native 68/89 original and 11/35 extra-vague ceilings cannot be reconstructed as a paired per-question control without rebuilding. Research `out/noembed/` artifacts remain. This round therefore reproduces the implementation document's **offline diagnostic**: current saved no-vector top 30 plus a neutral episode FTS top 30, fused with RRF60 and deterministic episode-hash ties, retaining 30. This is not the native metadata ranking, freshness, hydration, conditional judge or serialized page. Its baseline original recall@30 is 72/89 (80.9%), reproducing the previously documented offline probe. The failure below is an offline failure, not a newly measured native score.

The snapshot graph was opened `mode=ro&immutable=1`, copied through SQLite backup, and its SHA-256 checked unchanged before and after. All 714 corpus episodes were checked against active snapshot revisions. Complete summary/entity/claim/source fields were indexed, with project filtering before top-k. No language detection, per-language analyzer, stopword list or language-specific threshold was added. Every timed top-30 query was checked against the complete unlimited ordered SQL result; uniqueness and indexed row count were asserted. Question text, gold IDs, source content and per-question orders remain outside git.

## Fixed variants and development ceilings

All rows use NFKC/casefold, Unicode words and the product's CJK script ranges, including mixed-script splitting. Prefix matches apply to words, never encoded character postings. `2u` is the product-style bigram index with character unigrams; other modes omit indexed unigrams. All retain whole words. Query unigrams follow the existing single-CJK-character rule.

Baseline field weights summary/entity/claim/source are 4/2/1/0.25. Entity, source, equal and summary variants use 2/4/1/0.25, 4/2/1/1, 1/1/1/1 and 8/2/1/0.25 respectively. Rare-query variants retain terms whose corpus document frequency is at most the median among present query terms. They change retrieval hints, never stored or returned evidence.

These are **dev** counts, not held-out results for the grid. Ceiling means gold within the first 15 fused candidates.

| Variant | All R@30 /120 | Keyword ceiling /32 | Paraphrase /33 | Vague /21 | Extra /34 | Original /86 |
|---|---:|---:|---:|---:|---:|---:|
| baseline (2u) | 76 | 30 | 19 | 6 | 14 | 55 |
| no indexed unigrams (2) | 76 | 30 | 19 | 6 | 14 | 55 |
| bigram + word prefix | 74 | 30 | 18 | 6 | 15 | 54 |
| bigram + trigram | 74 | 31 | 19 | 7 | 14 | 57 |
| bigram + trigram + prefix | 73 | 31 | 19 | 7 | 14 | 57 |
| trigram + prefix | 73 | 30 | 17 | 6 | 14 | 53 |
| entity weight (23 + prefix) | 74 | 29 | 19 | 6 | 14 | 54 |
| source weight (23 + prefix) | 74 | 28 | 19 | 7 | 14 | 54 |
| equal fields (23 + prefix) | 74 | 29 | 19 | 7 | 14 | 55 |
| summary weight (23 + prefix) | 74 | 31 | 19 | 7 | 14 | 57 |
| rare query (23 + prefix) | 71 | 29 | 18 | 6 | 14 | 53 |
| rare query (2 + prefix) | 73 | 29 | 18 | 7 | 14 | 54 |

Baseline and no-index-unigrams were the only variants preserving dev keyword hit@5 (28/32) while attaining the maximum recall@30. They tied on all recall@30 (76/120) and recall@15 (69/120); no-index-unigrams won the protocol's latency tie-break, 0.870 versus 0.984 ms median lookup. This small timing difference is not evidence of a production speed improvement.

## Frozen held-out result and miss audit

| Slice | n | Baseline ceiling | Selected ceiling | Selected R@30 | Baseline / selected unjudged hit@5 |
|---|---:|---:|---:|---:|---:|
| keyword | 33 | 32 | 32 | 32 | 31 / 31 |
| paraphrase | 34 | 23 | 23 | 25 | 14 / 13 |
| vague | 22 | 11 | 11 | 15 | 5 / 5 |
| extra-vague | 35 | 15 | 15 | 16 | 6 / 6 |
| original | 89 | 66 | 66 | 72 | 50 / 49 |
| all | 124 | 81 | 81 | 88 | 56 / 55 |

Selected ceiling: **66/89 original, 15/35 extra-vague**, below the required **70/89 and 16/35**. Keyword ceiling and hit@5 were unchanged; no held-out question gained or lost top-15 membership. Selected median held-out lookup was 0.982 ms (baseline 0.951 ms), excluding the saved recall call. No native timing claim follows from this index-only measurement.

The saved research `best-judge` hit@5 found seven held-out questions whose gold is outside the neutral offline baseline's top 15: two paraphrase, three vague, two extra-vague. Six golds remain at fused ranks 16–30; one is outside 30. Five are in the research Korean FTS top 30; two are outside the neutral FTS top 30. Every one has at least one query-token overlap in **each** complete gold field. Thus the demonstrated failure is candidate order and the narrower top-15 judge pool, not absent gold episodes or missing entire fields. Removing indexed character unigrams did not recover any of these seven. This is a research-versus-offline audit, **not** the unavailable research-versus-native miss list.

The research judge saw 30 candidates, whereas the product judge sees 15. Research `current+ko2` itself has original R@15 64/89 and extra R@15 15/35, despite its judged hit@5 of 70/89 and 16/35. Comparing those judged scores with a top-15 ceiling requires increasing discovery/order quality; it cannot be achieved merely by reusing the historical judge scores. No judge-pool limit, deadline, source policy or quality budget was changed.

Not isolated here: the effects of research stopword removal, repeated gram frequency versus per-field distinct tokens, native metadata scores, graph deadlines and canonical rejection. Index field weights and token/query variants did not establish a winning neutral replacement on dev. There is no episode title column in the corpus; complete summaries and entity names are already separate weighted fields. Adding session titles or changing episode units was not attempted in this bounded round. SQLite's built-in BM25 parameters were retained; a custom BM25 scorer was not attempted.

| Fresh same-build judged comparison | Result |
|---|---|
| vectors + configured-model judge | Not run: failed offline gate |
| FTS + configured-model judge | Not run: failed offline gate |
| both + configured-model judge | Not run: failed offline gate |

No historical judged table is substituted for the requested fresh comparison. No product change, multilingual E2E run or accuracy acceptance is claimed.

## Reproduction and checks

[`benchmarks/fts-tune/offline.py`](../benchmarks/fts-tune/offline.py) accepts `ARTIFACTS SNAPSHOT_GRAPH OUTPUT_DIR`. The input directory is the existing private `out/noembed` archive; output must be a new directory outside the repo. It records script/input/snapshot fingerprints and the dev choice in `freeze.json` before any held-out search, plus aggregate `report.json` and private complete orders. The fixed grid is in source. It uses only Python's standard library and SQLite FTS5. Run under a fresh `HOME` and `BUTLER_DATA`. `audit.py ARTIFACTS OUTPUT_DIR` reproduces the historical-hit miss audit from frozen orders without additional retrieval or tuning. Delete the disposable output directory after inspection; retain immutable original artifacts.

- Offline round: passed structural assertions, 714 indexed episodes, 120 dev and 124 held-out questions; snapshot SHA unchanged. Accuracy gate failed as above.
- `cargo fmt --all` and `cargo fmt --all --check`: passed with isolated HOME/data; no builds.
- Source check: passed using the existing `codex-fts-fallback/target/debug/butler-source-check .` executable, whose source tree matches this worktree. An initial invocation with `-- .` failed usage validation. A subsequent repository-root invocation produced 190 platform-path violations because this checker expects the Rust workspace root; the correct Rust-directory invocation passed with zero violations. No Cargo build was started.
- Python syntax compilation, the aggregate miss audit and `git diff --check`: passed under isolated HOME/data.
- Clippy: not applicable; no Rust crate changed. Memory/multilingual E2Es and three-arm judging: not run, because product implementation was conditional on a winning variant and the task forbids builds before that gate.
- No task target was created. Disposable snapshot/index/order copies and Python bytecode were deleted after inspection. No PR requested.
