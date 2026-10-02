# Recall performance profile and smallest-change design

Measured 2026-10-02 on Linux x86_64 / WSL, after merging `origin/main` into
`codex/recall-perf`. This task changes no production code. Numbers below are
aggregates; conversation text, identifiers, individual results, SQL bindings,
judgments and plots remain outside Git under the private `bench/out/perf/`.
No generative model calls were made. Query embedding uses the existing local
native worker, as in the original real-recall benchmark.

## Measurement contract

The population is the 175 externally kept questions. Timing uses A1: the raw
question as cue, vectors enabled, the default six-result page, unchanged
ranking, expansion, deadlines and 24 KiB envelope. Byte counterfactuals use the
**complete** original `results.jsonl` payloads, never their 6,000-character
previews; external judgments come from `judgments.jsonl`.

Generic `profile_stage.py` copies sources outside the worktree and inserts
inclusive RAII probes into selected functions of the private memory/turn
copies. SQLite PROFILE callbacks capture expanded SQL and statement counters
only in private outputs. Probes are aggregated after the recall timer stops;
helper probes are deliberately restricted to avoid high-volume observer work.
The explicit vector deadline branch is counted independently of generic
unavailable coverage. No production exports or source files are edited.

Each reported timing condition has three sequential sweeps of all 175 queries.
Warm sweeps use a persistent process and embedding worker per sweep, with
native embedding warm-up excluded and measured separately. Cold calls use a
fresh process for **each query**, skip embedding warm-up, and first issue
`POSIX_FADV_DONTNEED` on files of the sealed copy. This is best-effort Linux
page-cache advice, not proof of eviction; Windows/device caches and pages held
by other readers cannot be dropped. No global cache flush, service stop or
shared process manipulation is used. Setup/calibration passes with broad probes,
overlapping checks, or a missing native asset stamp cache are excluded. Final
sweeps use restricted probes and the populated cache; all their failures remain
in the reported population. The stamp-cache preparation added only a 602-byte
cache file to the copy; prior copied assets and the snapshot remained unchanged.

The build is the same development profile used by the benchmark. These are
not release-service latency estimates. Shared-host load remains uncontrolled;
relative work shares and query plans are stronger evidence than milliseconds.
Stages are disjoint at their outer boundaries; substage/function times are
inclusive and must not be added to their parents. The generation resolve
inside argument binding is subtracted from binding before attribution.

Every timed response is checked for a nonempty successful complete JSON
payload, unique IDs in returned order, all gold ranks, the default result-count
bound, and the exact serialized byte count. Complete structured results and
coverage/deadline codes are retained. Nonempty and byte-budget failures are
reported with unsuccessful quality gates; completed calls are never rerun to
obtain a passing outcome. Sealed-copy and snapshot hashes verify
that the latest source state in this immutable experiment does not change.
This does not assert that deadline-dependent recall returns the same page on
every repeat, nor establish completeness of the underlying memory projection.

## Stage times and quality gates

Each condition contains all 175 queries repeated three times (525 calls).
Pooled call medians/p95 are below; p95 is nearest-rank. Shares are computed
per call before taking median/p95, so their medians need not sum to 100%.
Zero cold vector-validation time means the lane did not reach that filter.

### Cold

| Stage | Median ms | p95 ms | Median share | p95 share |
|---|---:|---:|---:|---:|
| Argument parsing/binding | 15.8 | 48.3 | 0.45% | 1.32% |
| Generation resolve (two reads) | 1.6 | 4.0 | 0.04% | 0.10% |
| Vector: embedding + Lance | 751.3 | 752.2 | 21.41% | 31.70% |
| Vector current-unit SQL filter | 0.0 | 0.0 | 0.00% | 0.00% |
| Query graph/canonical opens | 6.3 | 30.5 | 0.18% | 0.63% |
| Raw BM25 | 498.0 | 1057.0 | 14.45% | 24.27% |
| Canonical inventory audit | 282.2 | 582.9 | 7.71% | 16.94% |
| Projection coverage | 34.7 | 114.9 | 0.83% | 2.56% |
| Alias seeds | 50.5 | 146.7 | 1.51% | 2.67% |
| Lexical seeds | 771.3 | 1847.0 | 21.75% | 35.46% |
| Graph expansion (including PPR) | 127.4 | 335.3 | 3.67% | 7.05% |
| Ranking | 376.4 | 946.4 | 10.66% | 18.76% |
| Evidence binding + hydration | 379.8 | 891.6 | 10.64% | 20.16% |
| Envelope packing + encoding | 16.6 | 35.0 | 0.47% | 1.10% |
| Other seed channels | 0.1 | 0.2 | 0.00% | 0.01% |
| Scheduling/close/unattributed | 3.7 | 14.4 | 0.10% | 0.30% |

### Warm

| Stage | Median ms | p95 ms | Median share | p95 share |
|---|---:|---:|---:|---:|
| Argument parsing/binding | 3.8 | 6.4 | 0.11% | 0.28% |
| Generation resolve (two reads) | 0.9 | 1.7 | 0.03% | 0.07% |
| Vector: embedding + Lance | 335.9 | 754.0 | 11.04% | 22.43% |
| Vector current-unit SQL filter | 214.4 | 396.1 | 7.23% | 9.81% |
| Query graph/canonical opens | 4.1 | 7.6 | 0.12% | 0.31% |
| Raw BM25 | 261.3 | 677.8 | 8.78% | 19.97% |
| Canonical inventory audit | 427.7 | 737.7 | 13.20% | 20.91% |
| Projection coverage | 5.1 | 11.7 | 0.14% | 0.36% |
| Alias seeds | 9.8 | 15.5 | 0.29% | 0.63% |
| Lexical seeds | 521.5 | 1543.0 | 16.05% | 48.38% |
| Graph expansion (including PPR) | 363.5 | 1159.7 | 10.91% | 31.02% |
| Ranking | 323.0 | 576.4 | 9.97% | 13.20% |
| Evidence binding + hydration | 449.5 | 808.5 | 13.97% | 18.96% |
| Envelope packing + encoding | 19.9 | 40.8 | 0.63% | 1.29% |
| Other seed channels | 3.6 | 9.2 | 0.10% | 0.31% |
| Scheduling/close/unattributed | 5.1 | 13.0 | 0.16% | 0.34% |

| Condition | Wall median / p95 ms | Three sweep medians ms | Empty pages | Gold hit@5 |
|---|---:|---|---:|---:|
| cold | 3510.9 / 5625.3 | 3455.0, 3646.8, 3417.0 | 51/525 | 45.90% |
| warm | 3290.0 / 4857.7 | 3648.7, 3390.2, 2836.5 | 6/525 | 62.48% |

**Spread:** the median of the three sweep medians is 3,455.0 ms cold and
3,390.2 ms warm. Cold sweep medians span 3,417.0–3,646.8 ms; warm spans
2,836.5–3,648.7 ms. This sizeable warm spread reinforces the shared-host caveat.
Nonempty-only median/p95 is 3,386.5/4,978.7 ms cold and 3,261.9/4,786.5 ms
warm, provided only as secondary statistics; no failed samples were removed
from the principal table. Warm empty counts by sweep are 4/2/0; cold 26/12/13.

**Quality gates failed:** six warm empty responses; 51 cold empty responses
and three cold final-envelope violations (maximum 24,578 B). Every empty cold
page includes source `operation_deadline` and partial inventory codes. No tool
call returned an error. Structural consistency, exact byte arithmetic, unique
ordered IDs and gold-rank checks passed for all 1,050 calls. All 175-query
samples and failures remain recorded; none were retried to obtain green.

All three oversized payloads fit within 24 KiB if the subsequently inserted
`ok: true` field is removed. `response.rs::ResponseView` excludes that field,
whereas `service.rs::recall_tool` adds it after envelope packing (10 serialized
bytes). That demonstrated accounting gap explains these violations; no field
is removed and no production fix is made in this task.

**Vector deadlines:** cold 525/525 (100%) miss the embedding request deadline;
85 also take the explicit outer vector-lane timeout branch. Warm has no
embedding-request timeouts, but 42/525 (8.00%) explicit outer lane deadlines.
The union is 525 cold / 42 warm; do not double-count nested deadlines or label
every generic unavailable code as a timeout. Vector coverage is unavailable
in exactly those 525/42 calls. Cold has no Lance search or current-unit SQL
filter execution. Its lower expansion work and lower gold hit@5 (45.90%
versus 62.48% warm) are not quality-preserving savings. Original saved A1
hit@5 is 62.86%; main drift, probes, deadlines and host load confound any
causal comparison with the historical benchmark.

## Fixed request work: source inspection

Inclusive fixed/substage timings below are not additional to the stage tables.
Canonical-reader rows are totals across both opens; Lance rows execute only
when reached (all 525 warm calls, no cold calls).

| Work | Cold median / p95 ms | Warm median / p95 ms | Calls/recall |
|---|---:|---:|---:|
| Graph open, pragmas, revision | 3.20 / 28.76 | 1.07 / 2.15 | 1 |
| Canonical-reader opens | 10.76 / 34.25 | 6.01 / 9.20 | 2 |
| Canonical schema existence checks | 9.84 / 28.05 | 5.51 / 8.41 | 2 × 8 tables |
| Lance connect/table/schema open | not reached | 2.37 / 8.63 | 1 warm |
| Query embedding request | 750.85 / 751.81 (timeout) | 79.68 / 222.88 | 1 |
| Lance nearest, node + episode total | not reached | 248.29 / 549.94 | 2 warm |
| Numeric PPR inside expansion | 0.001 / 0.003 | 0.85 / 3.30 | 1 |
| Original-text source hydration inside binding | 204.33 / 588.63 | 202.40 / 376.86 | 1 |

Three warm-up times are 4,704.1/5,189.9/5,029.4 ms: median 5,029.4,
range 4,704.1–5,189.9. These include initialization and one generic inference,
outside the recall timer. Model/tokenizer load alone is not separately measured.
Reader reuse targets roughly 7 ms warm graph-plus-canonical open work (about
0.2% of wall), not seconds. Inventory instead consumes 427.7 ms median / 13.2%
warm share. PPR arithmetic is only 0.85 ms versus 363.5 ms expansion.

Graph opens use a read-only connection, busy timeout, `query_only`, `BEGIN` and
one graph-revision point read. The canonical store opens twice per recall:
public caller binding and the query's pinned source reader. Each open sets
read-only/query-only/foreign-key flags and validates eight required tables with
`sqlite_master` existence reads. There is no per-recall `integrity_check`,
`quick_check`, full database integrity scan or model reload in these paths.

The native owner lazily spawns and initializes one worker. Initialization belongs
to the owner and may finish after the initiating request times out; the worker
retains an `EmbeddingEngine` thereafter. Prepared asset stamps avoid repeating
large-file hashes. Lance still connects, opens the table and reads its schema
for each reached vector request, then searches node and episode lanes. The
small Lance open is separate from the larger nearest-search work.

The recurring audit is `read_canonical_inventory`: it pages all turn outcomes
and recovered messages, reads their sessions/turns/parts, decodes and hashes
canonical text, and only then applies source scope in Rust. It supports current
projection coverage and exclusions. It cannot be removed without preserving
the exact latest-state diagnostic contract.

`limit` is enforced during envelope packing after ranking and candidate
hydration. The hydration/claim binding cost is thus not bounded by the visible
four-result median. Expansion includes SQL adjacency/relationship work; the
numeric PPR function is a small substage, not the entire expansion cost.

## SQL work and query plans

Plans and complete result row counts were replayed with the product's bundled
SQLite **3.50.2**. Python plans were preliminary only (the native plan adds a
Bloom filter in lexical frequency lookup). Private SQL bindings/results are not
published. The examples below are the slowest captured instances of heavy
families; their replay times are not typical-stage estimates. One output row
from a COUNT does not imply one input row scanned.

| Stage / family | Complete output rows | Native plan and work | Baseline replay median ms (3-run min–max) |
|---|---:|---|---:|
| Lexical postings | 6,606 | Alias-postings gram covering PK; source/chunk/node/claim PK probes; DISTINCT temp B-tree | 309.67 (285.66–311.64) |
| Lexical document frequencies | 42,598 | MATERIALIZE eligible; alias covering scan + DISTINCT; `idx_alias_postings_gram_source`; automatic eligible index + Bloom filter | 1,213.99 (1,039.66–1,241.03) |
| Lexical corpus size | 1 | Scan alias covering PK; source/node/claim eligibility probes | 153.63 (152.20–166.04) |
| Raw BM25 term weights | 41 | `memory_source_terms` term PK; source-text rowid; source/chunk PKs; split-parent covering index | 86.18 (84.23–121.00) |
| Raw BM25 ranked sources | 64 | Term PK and source joins; GROUP BY / COUNT DISTINCT / ORDER BY temp B-trees | 194.87 (167.03–200.54) |
| Vector incomplete coverage, broad | 1 | Scan vector-unit PK, then job/chunk/source indexes; all 15,582 units considered | 67.95 (67.01–71.62) |
| Expansion eligible adjacency | 4 | OR source/target edge indexes; edge evidence and scoped source joins; support COUNT DISTINCT + sorting | 0.69 (0.38–0.89) |
| Expansion mention inputs | 4,693 | `memory_evidence_episode`; node/source/chunk/claim PK probes; ORDER BY temp B-tree | 41.36 (35.56–47.34) |
| Ranking relationship support | 1 | `memory_evidence_episode`, `memory_edges_claim`, edge evidence/source joins; COUNT DISTINCT | 0.66 (0.57–0.79) |
| Binding requirements | 0 in sampled statement | Episode evidence index + node/source/chunk/claim point checks | 0.19 (0.19–0.20) |
| Inventory outcome page | 500 | Outcome rowid range plus newer-outcome turn index | 2.52 (2.16–3.08) |
| Inventory/hydration message parts | 1 in sampled statement | `conversation_parts_message_part_idx` | 0.03 (0.03–0.13) |

Many short statements matter: warm recalls invoke the canonical `read_message`
median **1,943** times, p95 **2,768**, across inventory and hydration; the result
bind function has median **126** invocations, including packing rebinds, versus
four visible results. Ranking's current-row work is 228.5/385.4 ms median/p95.
A single cached part read is cheap; thousands of point reads, decoding and
hashing explain why the outer inventory/hydration stages are heavy. SQL
callbacks do not retain caller stacks, so shared point-read families cannot be
partitioned precisely between these stages. No >=1 ms alias-exact PROFILE
statement was captured in warm sweeps; its prepare/execute split and an actual
slowest alias SQL replay remain unmeasured (outer lane time is measured).

Graph file: **1,629,818,880 B**. Alias postings plus their five indexes occupy
**1,423,089,664 B (87.32%)**, consistent with the previously rounded 88%.
Their table has **886,340 rows**; aliases **15,240**, nodes **13,165**, evidence
**14,864**, source text **1,933**, source terms **1,409,772**, chunks/jobs **727**.
The three largest alias indexes are 313.8/311.3/308.3 MB; the postings table
288.9 MB, gram-source index 124.0 MB, scope-gram-node index 76.8 MB.
The slow frequency sample binds **42,604 grams**, because lexical selection
collects grams from all candidate aliases, not only the cue. This is measured
work attribution only; ranking/expansion and alias-storage changes are excluded.
The copied canonical store has 3,215 messages, 12,899 parts and 1,202 outcomes.

### Partial-index experiment

Separate writable copies only; original sealed copy/snapshot remain untouched.
Thirty graph families and six canonical families were replayed three times per
baseline/copy condition, alternating order. The alternate index repeats all 30
graph families. Every timed execution compares **all columns, rows and order**
with the original query, including counts and scope; all 396 executions pass.
No table rows change. There are 14,976 complete and **606 noncomplete** vector
units (11 failed, 144 pending, 451 superseded), out of 15,582.

`(unit_id,job_id) WHERE state!='complete'` preserves the ordered DISTINCT scan
while excluding complete units. Broad plan becomes `SCAN u USING INDEX
recall_perf_units_incomplete`, followed by the same job/chunk/source probes.
Three baseline times are **72.16/59.94/76.01 ms**; indexed **40.72/7.94/10.62 ms**.
Median improvement is **85.3%**; the spread still shows cold-copy/shared-host
noise. Index size **90,112 B**, scratch build **279.9 ms**. The scoped query
retains its original plan (40.46→39.42 ms median; no demonstrated benefit).
The tested job-first alternative helps scoped queries **28.44→5.31 ms**, but
its broad plan still scans the full vector-unit PK (**67.95→63.53 ms**, no
convincing gain). These are two retained alternatives, not retries of a failing
quality test. The existing `idx_vector_units_owner_current` already matches
owner/revision/kind/state/job; native node/episode membership reads are around
0.2–0.4 ms each. Adding another owner index would duplicate existing work.

## Response bytes and the quality knee

Original A1, 175 queries: median **23,872 B**, p95 **24,506 B**; mean **23,074 B**.
Median returned count is **4**, p95 **6**, despite a requested limit of six.
The external full-page answer-present rate is **57.71%**. The independent
normalized answer-substring proxy is **58.86%**; these are different metrics.

The following attribution sums exactly for each serialized response. Field
names/values are charged to their part; braces, array brackets and separators
are charged to structure. Per-part medians do not sum to the total median.

| Part | Median B | p95 B | Share of mean bytes |
|---|---:|---:|---:|
| Ranked IDs, revisions, summaries, times and channels | 2,049 | 3,415 | 8.78% |
| Evidence excerpt fields | 2,912 | 4,586 | 12.88% |
| Evidence bindings, support and read arguments | 4,787 | 6,863 | 21.30% |
| Graph and claim detail | 12,617 | 15,143 | 53.62% |
| Cursor | 176 | 176 | 0.76% |
| Status, coverage, diagnostics and `ok` | 412 | 456 | 1.74% |
| JSON structure | 203 | 290 | 0.92% |

Within graph/claim detail, serialized `interpretations` values alone have a
**10,803 B median / 13,422 B p95**. Requirements are **758 / 2,723 B**;
association paths **10 / 436 B**. The response is primarily claim-detail
serialization, rather than a long excerpt dump.

### Existing page restricted to top k

These are offline prefix deletions from existing pages, **not** reruns with a
smaller product `limit`; removed bundles are not replaced or upgraded. The
private standalone numeric plot is `bytes-tradeoff-standard.svg` under the perf output.

| k | Median B | p95 B | Gold hit@k | Answer substring proxy | External answer-present bounds |
|---|---:|---:|---:|---:|---:|
| 1 | 5,809 | 10,709 | 40.57% | 40.57% | 0–57.71% |
| 2 | 11,821 | 18,609 | 53.14% | 49.71% | 4.57–57.71% |
| 3 | 16,688 | 24,119 | 58.29% | 55.43% | 20.00–57.71% |
| 4 | 21,085 | 24,373 | 62.86% | 58.86% | 31.43–57.71% |
| 5 | 23,099 | 24,480 | 62.86% | 58.86% | 42.29–57.71% |
| 6 | 23,872 | 24,506 | 63.43% | 58.86% | 57.71% (original) |

**Four is the gold/proxy plateau on this sample**: the fifth result adds no gold
or answer-substring hits; the sixth adds one gold hit (0.57 percentage points),
with no additional answer-substring hits. Three is a cheaper elbow, but loses
4.57 pp gold hits and 3.43 pp answer-substring presence versus four. Even the
four-result plateau still sends 21.1 KB: result count alone is a weak remedy.

A whole-page external boolean cannot identify which result or excerpt carried
the answer. Assuming existential answer presence is monotonic under deletion,
the modified-page upper bound is the original 57.71%; the
conservative lower bound counts judged-positive pages whose result contents
are completely unchanged. The proxy is reported separately, not relabeled as
external answer judging. Fresh per-result or modified-page judgments would be
required to narrow these intervals; none were requested from a model here.
If a judge's contextual decision is not monotonic, that upper bound is invalid;
these are conditional bounds, not measured reduced-page judgment rates.

### Evidence prefix cap per result

The cap is N UTF-8 bytes **in total across that result's excerpts**, consumed
in existing evidence order, respecting UTF-8 boundaries. All metadata, ranked
IDs, claim detail and the original page length stay intact. This is a diagnostic
counterfactual, not a proposed clipping implementation. Hit@5 stays **62.86%**
for every cap because IDs are unchanged; that does not imply answer fidelity.

| N bytes/result | Median page B | p95 B | Answer substring proxy | Previously matched answers lost |
|---|---:|---:|---:|---:|
| 0 | 20,751 | 22,532 | 48.00% | 19 |
| 120 | 21,188 | 23,159 | 48.57% | 18 |
| 240 | 21,611 | 23,702 | 51.43% | 13 |
| 480 | 22,241 | 24,248 | 56.00% | 5 |
| 960 | 23,204 | 24,481 | 58.29% | 1 |
| 1,920 | 23,780 | 24,483 | 58.86% | 0 |
| 3,840 | 23,872 | 24,506 | 58.86% | 0 |
| 7,680 | 23,872 | 24,506 | 58.86% | 0 |

There is no useful excerpt-clipping knee: preserving the proxy needs 1,920 B
per result, saving only 92 median page bytes. At 480 B the median saving is
1,631 B (6.8%) but five existing answer matches disappear. Removing excerpts
entirely still leaves a 20.8 KB page.
The private numeric/plot artifact also carries conditional external bounds for
each cap; as with top k, the saved whole-page judgments cannot identify the
answer-present rate of a changed excerpt.

Deferring `interpretations` alone would leave **12,472 B median** (47.8%
smaller), with unchanged gold hit@5 and a **57.14%** answer-substring proxy
(three fewer matching pages). Deferring interpretations, requirements and
association paths together would leave **11,360 B**, with the same proxy.
These are first-page presentation simulations; they do not judge quality after
on-demand expansion or prove any end-to-end token/latency improvement.

### What limit and the tool description actually promise

`memory_recall/tool.rs::limit` accepts integers 1–20, default six.
`response.rs::fit_minimum` stops after that many fitting minimum bundles;
`upgrade_to_full` then fills remaining envelope space with full bundles. Thus
limit bounds count, but does not prescribe excerpt/detail budgets and is applied
**after** selection, ranking and hydration of the candidate set.

On kept A2 calls, the 113 requests for five results had median **23,375 B**;
the 62 requests using six had median **24,014 B**. Both returned a median four
results, with maxima five and six respectively. This comparison is descriptive:
A2 arguments/scopes differ, so it does not isolate the causal effect of limit.

The actual tool description says it recalls source-backed associative context
through graph evidence and instructs the model to use `evidence.read_args`
unchanged to inspect canonical source text. `limit` is described only as the
maximum number of results. Neither description advertises a byte/token target,
the default six, the 24 KiB envelope, or a compact-vs-expanded presentation.
There is no basis for expecting the caller to infer that `limit: 5` means a
small response. Byte savings here are measured UTF-8 JSON savings; no fixed
bytes-per-token conversion is assumed for mixed Korean, text and opaque IDs.

## Smallest-change proposals

No proposal changes recall ranking/expansion or alias postings storage. Their
costs are reported for the owners of those tasks. Gains below are opportunities,
not summed speedups: meeting existing deadlines can admit more vector hits or
hydrate more evidence, increasing subsequent work and changing actual pages.

1. **Index only incomplete vector units — mechanical, small.** Start with
   `(unit_id, job_id) WHERE state!='complete'`. Native replay changes the broad
   coverage plan from a 15,582-unit scan to the 606-unit partial index, preserving
   complete count results and order. The sample median falls 72.16→10.62 ms
   (85.3%); expect about 45–65 ms less work on broad-scope calls, roughly 1–2%
   of a recall, with no demonstrated gain on scoped calls. Only 204/525 warm
   calls use that broad family; do not advertise this as a multi-second fix.
   The index is 90,112 B and built in 280 ms on the scratch copy. Write/migration
   cost is the small risk. No intended hit@5 or answer-present change; faster
   completion can still alter deadline-admitted content and needs a full recall
   comparison before shipping. The owner/revision index already exists and is
   used, so adding another owner index is rejected. A job-first partial variant
   helps the scoped family (28.44→5.31 ms) but leaves the broad scan unchanged;
   start with one index, not both. Neither modifies alias postings storage.

2. **Make claim interpretations expandable first-page detail — behaviour,
   owner's approval required.** Keep rank, summary, source references, evidence
   read arguments, qualification and verification flags. Return stable handles
   for the full interpretations and expand them on demand from the same pinned
   generation/revision; retain every existing field in the expansion. The offline
   preview median is 12,472 B, 47.8% below today's page before handle overhead.
   Expect roughly 40–48% first-page byte savings, with no fixed token conversion.
   Gold hit@5 on existing IDs stays 62.86%; preview answer-substring presence is
   57.14%, versus 58.86% originally. Expanded external answer-present and total
   interaction latency/tokens are unmeasured. Include a clear compact/default
   description and explicit detail operation; do not silently clip evidence or
   drop content to satisfy performance. A hard top-four page alone saves only
   11.7% median bytes and may move discoveries to a subsequent page.

3. **Warm the persistent native embedding worker before recall readiness —
   mechanical, small to medium.** The model/tokenizer are already reused within
   one process; this is a readiness/startup change, not per-call model caching.
   Populate asset stamps when preparing immutable model assets, initialize the
   worker and run a generic local query before advertising vector readiness.
   Cold bootstrap misses are 100% in this experiment, but the 8% warm search
   deadlines would remain. The warm-up is startup work and must remain visible;
   it consumes resident RAM. This can remove cold bootstrap from the vector
   deadline but does not
   eliminate Lance search or SQL validation. More admitted vectors can alter
   deadline-dependent recall results; no quality gain is assumed without a
   complete-page comparison. Do not raise the vector deadline.

4. **Reuse readers and schema checks within one recall — mechanical, small,
   low gain.** Binding opens a public canonical reader and the query opens a
   second canonical reader; graph and Lance readers also open on each recall.
   First consider avoiding duplicate opens/schema statements within the request,
   keeping public-snapshot/pinned-transaction boundaries intact. A reusable
   connection must start a fresh transaction and check generation/schema changes;
   never retain stale source snapshots across requests. The measured connection
   cost is only milliseconds, so this is cleanup after larger work is addressed.
   No intended ranking, evidence or answer-present change.

5. **Replace the request-time canonical inventory sweep with exact maintained
   revision/coverage state — medium to large, last on gain/risk/size.** Every
   recall rereads outcomes and recovered messages, decodes source parts and
   hashes canonical content to determine coverage. An exact mutation-driven
   inventory could avoid repeated work, but must track all source, part, outcome,
   session/project/status and projection changes, including recovered text and
   historical/as-of rules. Keep today's latest-state exclusions and pending/
   unavailable diagnostics. Simply skipping the audit or serving cached stale
   coverage is rejected. The source reader already exposes a store identity and
   public revision, so first audit those mutation guards rather than inventing
   a new clock. Reuse only a complete inventory for the exact identity/revision
   and scope/as-of key, verified in the request's fresh pinned snapshot; absent
   or untrusted guards require the existing scan. Never reuse a deadline-cut
   partial inventory. This is mechanical only if equivalence is proved for
   complete content, order and current diagnostics; any changed coverage policy
   needs the owner's approval. No intentional hit@5/answer-present change, but
   it requires broader validation and is not the first implementation task.
   Stable-revision hits have a 427.7 ms / 13.2% warm opportunity ceiling; misses
   retain the scan. Real mutation frequency and achievable cache hit rate are
   unmeasured, so the immutable benchmark cannot establish the live gain.

## Limits of these measurements

Validation: benchmark fmt/check and standalone probe rustfmt pass; normal
`clippy -D warnings` passes for the benchmark and instrumented source copy.
Source-check passes on the Rust workspace and the combined workspace/harness.
Python syntax, additive byte accounting and UTF-8 boundary checks pass; existing
verification passes original 210/840 records and all six new 175-call sweeps.
Both partial-index experiments pass complete row/order checks on 396 timed SQL
executions; SVG/PNG/PDF curves were exported. Final snapshot/copy content hashes
are unchanged. Native warm-up succeeds, but recall quality gates fail as above;
a separate reproducible preflight also returned an empty page at 10,609.5 ms.
The extra `clippy --all-targets` check fails on 25 pre-existing `expect()` uses
in copied native tests, beginning at `crates/butler-agent/src/host/embedding/
owner/tests.rs:7`; they are untouched, with no lint suppression or test skips.

- Cold means fresh harness/service/native-worker process and best-effort copy
  page-cache advice. It is not a controlled global RAM/device/Windows cache drop.
  Cold and warm have different admitted lanes; a fast cold response with no
  vector hits or deadline-cut hydration is not a quality-preserving speedup.
- Native warm-up measures model/tokenizer loading, worker IPC and one inference
  together. Their individual load times and off-request background completion
  after a timed-out cold request are not separately instrumented. Lance open
  and search are measured only when reached, not imputed to timed-out calls.
- These probes add overhead and use development builds on a busy shared host.
  Three-run spread is reported, not a claim of release-service p95. Millisecond
  SQLite PROFILE omits statements rounded to zero; statement counts from that
  stream are lower bounds. VM/full-scan counters can accumulate when a compiled
  statement is reused; they are diagnostic work signals, not summed per-call
  row counts. Native query replay provides complete result counts and equality.
  Plans/row counts are stronger work evidence.
- Actual caller/model tokenizer counts, newly judged modified pages, quality
  after expansion and total recall-plus-expansion latency/tokens were not
  measured. Offline top-k removal does not emulate repacking a smaller limit.
- The harness directly invokes the tool service with its benchmark context and
  no production metrics sink. Outer agent/tool wrappers, real caller working
  context, live writes, contention and owner release deployment are unmeasured.
- No production fixes, live model calls, push or PR are part of this task.
  Proposed mechanical changes still need latest-state, full-content and ordered
  response validation on changing data before implementation is complete.
