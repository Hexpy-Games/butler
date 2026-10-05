# Per-script index and fallback top-30 judge experiment

2026-10-03, Linux x86_64 / WSL. **Top-30 rejected; coordinator adopts Script15 for the no-embedding fallback.**

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

## Experiment decision and deferred implementation (historical)

**Reject top-30 adoption.** Per-script30 hit@5 is 56/89 original and 9/35 extra, below 70/89 and 16/35.
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

## Coordinator adoption: Script15

The coordinator adopts the frozen per-script analyzer only as the fallback when
embeddings are unavailable; vectors stay primary. Script15 improves original
judged hit@5 from neutral's **50/89 to 54/89** and meets the owner's multilingual
definition: each language is findable in its own language, without requiring
cross-language matching. The research targets remain unmet. Top-30 is not adopted:
its paired improvement CI includes zero and the experiment reports about ten times
the recall-judge benchmark's input usage (the accounting difference is explained below).
The judge retains **15 candidates**, 150-character summary prefixes, its gate,
8-second deadline, RRF60 and complete-order fallback.

The apparent ~13.4k versus ~1.2k input cost compares different measurements.
`benchmarks/fts-script/judge.py` runs `codex exec`, so reported API input includes
Codex's agent instructions/wrapper and cached input, even though no tools execute;
its Script30 median is **13,362 API tokens**, versus **2,224 payload-estimate tokens**.
Script15 likewise reports **12,316.5 API tokens**, but only **1,178.5 payload tokens**,
consistent with the [recall-judge benchmark](recall-judge-plan.md)'s **1,160.5**
held-out median payload estimate. Both estimates exclude provider role/schema
framing and lack a verified model/tokenizer mapping; neither is billable usage. The wrapper
adds about **11.1k tokens** in both arms; doubling candidates roughly doubles the
payload, rather than multiplying it tenfold. Product `ConfiguredRecallJudge::call`
sends only the ranking instructions, question, numbered summary prefixes and JSON
schema through `ProviderPromptPort`, with no Codex CLI, conversation history, tools
or excerpts. Existing stub judge E2Es inspect the actual provider request; no live
call is needed or made for this adoption, and no new measured billable usage is claimed.

Production uses Unicode Script routing after NFKC/full case folding: Hangul follows
the frozen cue stopwords, distinct runs, repeated bigrams across runs and character
postings; Latin/Cyrillic/Greek words fold diacritics; Han/Kana/Thai and the other
frozen unspaced scripts keep runs and bigrams. All complete fields share one index.
Unicode Script properties come from [unicode-script 0.5.8](https://docs.rs/unicode-script/0.5.8/unicode_script/enum.Script.html).

Existing-index upgrade is optional background work under the existing cache lease,
with a persisted episode-ID cursor and upper bound. Each consumer step queues at
most 32 existing rows and projects at most 32 pending rows; cursor and queue advance
transactionally and survive interruption/restart. New writes use Script15 immediately.
Recall reports partial coverage during migration. There is no startup/turn wait,
new timer, idle lease or idle commit. Existing generation cleanup and reset triggers
continue to remove the same index/metadata/pending rows. Fresh stub scenarios cover
Korean, English, Japanese, Chinese, French accents and mixed Korean/English, then
emulate the legacy index and verify upgrade, restart and chat reset with no vectors
or embedding worker. The existing pure-logic cache-index assertion also checks
65-row batches (32/32/1), rollback and persisted cursor continuation.

## Adoption validation

Checks use fresh HOME/BUTLER_DATA, real Cargo/Rustup caches, pinned Rust 1.91,
`-j 8`, one build at a time, and at most four test threads (memory runs serially).
No live model calls, owner data, installed service or model-server ports are used.

- Agent build and `cargo fmt --all`: passed. Memory unit tests: **107 passed**,
  including frozen analyzer parity cases, bounded cursor rollback/resumption and
  graph-revision invalidation when an empty migration finishes.
- Stub memory: **23 passed** (279.03 s), including six same-language
  remember/upgrade/restart/reset cases and compact judge provider-request assertions.
- Stub memory_reset: **3 passed** (5.23 s); memory_wiring: **4 passed** (5.24 s).
- Stub memory_idle: **3 passed** (73.21 s). MEM-IDLE's **60.001 s** window observed
  **zero graph commits, leases, memory workers and embedding workers**, with
  unchanged graph/WAL/lock signatures and all 30,000 windows plus the deferred
  vector still present. Whole-service logical/physical reads were **79,211,538 /
  32,329,728 bytes**; these counters do **not** establish zero total idle I/O.
  The later idle investigation below found repeated aborted index builds behind
  these reads; the original zero-commit result did not establish a settled service.
  Changed-source catch-up: **59,170 ms**. Crash recovery: one recovered observation,
  zero further graph writes.
- Initial memory_rules (the `memory_wiring_more` binary): **12 passed / 1 failed**
  at `tests/memory_rules/failure.rs`'s manifest equality check. The fixture froze
  its manifest immediately after an accepted concurrent correction, although
  durable capture may still await the shared lease. Retained capture/operation
  timestamps and the journal's deferred commit path show that the snapshot could
  precede that correction's commit. The fixture now waits for the new active
  revision and both durable operation receipts before freezing the snapshot;
  the unchanged byte-equality, stale-refusal and operation-count assertions remain.
  The corrected complete failure/recovery scenario passed (**6.77 s**); the
  complete suite then **13 passed** (**72.00 s**) with the original four-thread
  contention, including active turns and queued follow-ups at all seven crash stages.
- Source-check: passed, zero function-size, platform, test-policy, architecture
  and E2E-gate violations. `git diff --check`: passed.
- Final clippy on `butler-memory` and `butler-e2e`, all targets, `-D warnings`:
  passed. Early clippy runs caught slice indexing and a redundant closure; both were
  corrected. A premature check during manifest editing missed the new dependency;
  a command from the repo root had no Cargo workspace and ran no checks/tests.
- The Unicode Script dependency is pinned to 0.5.8 (Unicode 17). Its MIT/Apache
  evidence was collected with the repository collector; unchanged license entries
  were retained, fingerprints refreshed and notices regenerated. Notice generation,
  determinism/policy checks and disclosure checks: passed. No TypeScript/UI change.

Zero total service idle I/O remains unverified (`tests/memory_idle.rs:266` reports
process-wide counters); no claim of a cause for those broader reads is made.

## Experiment validation (historical)

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


## Idle I/O regression investigation (2026-10-03)

Same Linux x86_64 WSL host, debug agent, stub provider, unchanged original
MEM-IDLE test, two independent 60-second windows per ref. Builds used `-j 8`
and ran serially; comparison tests used one thread and fresh HOME/BUTLER_DATA.
The shared host page cache was left intact, never globally dropped. Each fixture
copied a fresh executable and created a fresh graph; libraries and subsequent
runs were warm where the host retained pages. Physical counts therefore reflect
uncontrolled eviction, while logical counts establish the repeated work.

| Ref | Run | Logical read bytes | Physical read bytes |
| --- | --- | ---: | ---: |
| `origin/codex/recall-judge` (`5f56d394d`) | 1 | 70,848 | 0 |
| same | 2 | 70,848 | 0 |
| `37d5e2bfa` | 1 | 79,178,706 | 0 |
| same | 2 | 79,190,994 | 0 |
| `6579ebfc1` | 1 | 79,190,994 | 0 |
| same | 2 | 79,190,994 | 7,286,784 |

All six original windows reported zero graph commits, leases and memory/embedding
workers, unchanged graph/WAL/lock signatures, all 30,000 completed windows and
one deferred vector. These assertions alone missed an aborted initialization.

The introducing commit is `b9cd00780`, the initial FTS adoption, rather than
Script15 commit `6579ebfc1`. The cache owner installed FTS triggers against a
legacy graph lacking `memory_source_text`. `episode_fts/schema.rs::install`
failed with `no such table: main.memory_source_text`, rolling back the surrounding
transaction in `graph/cache_work.rs::ensure_cache_index`, including the freshly
built `idx_jobs_hot_cache`. Its absence requested another build on every poll.
The error path uses the existing five-second backoff. A content-free strace
(`-s 0`, read/pread/open/close only) and temporary stage diagnostics showed
12 approximately 6.5 MB graph-read bursts in the idle window, totaling
78,165,168 graph bytes; service logical reads were 79,211,538 bytes. No tokenizer
dictionary was opened: Script15 uses compiled Unicode tables. The temporary
diagnostics have been removed.

The leased cache work owner now runs the existing graph migration once before
installing a missing cache/FTS index. Schema creation, bounded re-indexing and
projection remain on this work path, with no new timer or work in the probe.
A second defect surfaced when installation succeeded: FTS-only progress counted
as text progress and admitted the aged deferred vector backlog. The initial
schema-only fix read 1,578,326 logical bytes, wrote 59,720 logical / 106,496 physical
bytes, and failed the new read assertion. Stage diagnostics confirmed repeated
vector `memory_source_changed` errors. Cache advancement now reports consumer
progress separately from text advancement; only actual semantic/cache text work
admits deferred vectors, retaining the existing daily/warm/backlog policy.

MEM-IDLE now seeds the legacy graph and aged deferred vector before startup,
requires the cache index and completed Script15 migration before measuring,
asserts less than 128 KiB logical and physical reads per window and zero disk
writes, and retains all content/worker/commit/lease assertions. No budget was
relaxed and no existing test was skipped.

The first final run met the read budget (66,752 logical / zero physical bytes)
and zero disk writes, but exposed an incorrect new assertion that Linux `wchar`
should be zero. Its 2,928 bytes were 8-byte Tokio eventfd wakeups, not file writes.
A write-destination trace verifies this distinction; `wchar` is reported, while
zero physical writes and the unchanged graph/WAL/lock signatures assert the
storage requirement. The logical and physical read budgets remain unchanged.

Final stub MEM-IDLE: **3 passed** (74.10 s, four test threads). The idle window
was 60.001 s with **66,752 logical read bytes, zero physical reads and disk writes,
zero graph commits/leases/workers**, unchanged files, all 30,000 completed windows
and the one deferred vector. Changed-source catch-up was **56,946 ms**; crash
recovery found one observation and no further graph writes.

The first broader memory invocation had **19 passed / 4 failed** at the explicit
`local embedding assets required` fixture precondition: the asset environment
variable was unset. No product behavior ran in those four cases. With
`BUTLER_E2E_EMBEDDING_ASSETS=/home/yeonw/.cache/butler-task-tools/bge-m3`, all requested
stub suites passed with four threads: **memory 23** (90.26 s), **memory_reset 3**
(7.58 s), **memory_wiring 4** (7.34 s), **memory_rules via memory_wiring_more 13**
(75.89 s). The real local embedding cases preserve daily/new-text admission and
worker release; rules cover active turns plus queued follow-ups at crash stages.

A second fixed MEM-IDLE run, with one test thread as in the original comparison,
passed in **72.11 s**: **60.001 s**, **66,752 logical read bytes**, **zero physical
reads and disk writes**, **zero commits/leases/workers**, complete fixture state.
Its 2,872 logical write bytes are IPC; the separate syscall trace observed only
2,432 bytes of service eventfd writes and no file writes in its idle window.

Final checks: **107 memory unit tests passed** (3.20 s, four threads),
`cargo fmt --all` passed, `cargo clippy -j 8 -p butler-memory -p butler-e2e
--all-targets -- -D warnings` passed, and `cargo run -j 8 -p butler-source-check
-- .` from the Rust workspace passed with zero function-size, platform,
test-policy, architecture and E2E-gate violations. A prior source-check invocation
from the repository root used the wrong relative package scope and was corrected
to the tool's expected Rust workspace root, without changing checker rules.
Temporary diagnostic builds/tests failed during investigation; none of their
instrumentation remains. Final `git diff --check` passed. No acceptance item is
left undone; no TS/UI changed and no live cassette was recorded.
