# Alias posting storage: issue #435

Measured on 2026-10-02, branch `codex/alias-postings`, base `53fa0a313`.
Scope: synthetic measurements plus production compact storage and an opt-in
background migration. Ranking and expansion are unchanged. Both migration and
physical reclaim are disabled by default; qualification below is required before
the owner enables either against live data.

## Reproduce and interpret the measurement

The stdlib-only harness is [benchmark.py](../scripts/alias-postings/benchmark.py).
It reads the current production table definitions and the four posting SQL
statements directly from Rust. Changes to their text therefore change the next
measurement; it does not maintain a separate simplified recall query.

```bash
task_sandbox=$(mktemp -d "${TMPDIR:-/tmp}/alias-bench.XXXXXX")
mkdir -p "$task_sandbox/home" "$task_sandbox/data"
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$task_sandbox"' EXIT
env HOME="$task_sandbox/home" BUTLER_DATA="$task_sandbox/data" \
  PYTHONDONTWRITEBYTECODE=1 \
  python3 packages/butler-agent/rust/scripts/alias-postings/benchmark.py \
  --output "$task_sandbox/results.json" --repeats 3
# Preserve results.json elsewhere before exiting if needed.
```

The harness refuses HOME/BUTLER_DATA outside TMPDIR and creates/deletes its own
synthetic SQLite files there. It makes no model calls and reads no user data.
Seed 435 produces exactly 14,293 nodes, 16,561 aliases, and 886,340 unique
bigram/trigram postings. Alias surfaces are exactly 83 characters; node keys are
36-character UUIDs and source keys are 64-character SHA-256 strings. Their
53.52 postings/alias is the quotient of the issue's totals (the issue's ~58 is
an estimate). Repeating 27-character motifs gives 53/54 distinct grams per
alias. Mixed lowercase ASCII/Hangul produces 168.98 UTF-8 bytes/alias. Every
fixture character is already folded and a single-codepoint grapheme; the Python
generator is deliberately not a general replacement for Rust's Unicode code.

SQLite 3.46.1, Linux x86_64 WSL2, 4-KiB pages, WAL, synchronous=NORMAL,
32-MiB connection cache, no ANALYZE or VACUUM. These write settings apply to the
build/copy connection. The reopened replacement probe uses SQLite defaults:
synchronous=FULL, wal_autocheckpoint=1000, foreign_keys=OFF; its commit latency
therefore includes automatic checkpoint work. It explicitly deletes old grams
before dictionary rows and checks complete latest recall, but does not qualify
production FK enforcement. Builds commit 128 aliases at a time
and request PASSIVE checkpoints between batches. Read timings include fully
fetching rows, with one first execution followed by three repetitions; medians
are warm measurements, not cold disk latency or p95. OS caching and other host
services are uncontrolled. Rust uses bundled rusqlite SQLite: qualification must
repeat this on that build and supported platforms before enabling anything.

Synthetic exclusions cover inactive chunks, obsolete revisions, internal
conversation sources, future observations, expired claims, project/session
scope, and include-internal. Each timed query checks the entire result against
an independent fixture oracle, including ordering, surface text and counts.
Frequency binds include all grams from every matched alias, not just cue grams.
Sixty-four committed alias replacements then verify latest-state recall.
FTS-only measurements assert its native trigram results and separately record
that they fail recall equivalence; they are not passing performance alternatives.

Raw evidence, including every SQL statement, source location, scope/cue,
EXPLAIN QUERY PLAN, first/median/max latency, result count/hash, dbstat object
bytes and write cost, is in [alias-postings-measurements.json](alias-postings-measurements.json).

## Baseline dbstat

| Object | Synthetic MiB | Issue reported MB |
| --- | ---: | ---: |
| Posting table | 263.93 | 275.6 |
| PK autoindex | 294.35 | 294.0 |
| Alias reverse index | 294.75 | 299.3 |
| Entity index | 289.33 | 296.9 |
| Gram/source index | 113.73 | 118.2 |
| Scope/gram/node index | 59.54 | 73.3 |
| Posting subtotal | 1,315.63 | ~1,357.3 |
| Complete synthetic database | 1,351.44 | owner graph ~1.55 GB |

This confirms the storage mechanism and approximately the absolute posting
footprint. It does not independently confirm an owner's 88% ratio: postings are
97.35% of this fixture, whose other graph tables contain only enough content to
exercise recall. No unrelated padding was added to force the denominator. The
synthetic aliases include three original/NFC/folded text columns and their
indexes; the issue's aliases and unrelated graph payload have different sizes.
The issue's MB unit was not specified; all new measurements use binary MiB.

## Variants and results

The variants preserve all existing scopes and eligible source joins. SQL views
translate surrogate keys back to the existing text columns for measurement;
these views are a prototype adapter, not an enabled production read path.

- `baseline`: rowid table, text composite PK, all four secondary indexes.
- `without_rowid`: only change the table's storage, retain all indexes.
- `drop_redundant`: remove gram/source and entity indexes, retain the alias
  reverse and scope indexes. This evaluates removal together, not each possible
  subset; the gram/source index is a PK prefix but is a smaller covering index.
- `surface_once`: replace posting surface text with an INTEGER alias-document
  key; keep text node/source keys and all four index shapes.
- `integers`: replace node, source, and surface keys with INTEGER dictionaries;
  keep six posting columns and all four indexes. Dictionary bytes are included.
- `compact`: store `(gram,alias_id)` WITHOUT ROWID and one reverse index;
  retrieve node/source/surface from the alias dictionary. Scope remains live
  in node/source/chunk tables rather than being copied into every posting.
- `compact_native`: identical storage, with the frequency CTE resolving
  eligible alias IDs once. Candidate selection still uses the adapter. This
  changes only SQL storage access inside the harness; no Rust read path changed.
- `fts5_trigram`: external-content FTS5, full positional detail, instance vocab
  DISTINCT `(term,doc)` to count aliases rather than repeated occurrences.
- `fts5_hybrid`: same FTS5 plus ordinary compact bigram postings. This preserves
  the fixture's bigram behavior and measures a fairer storage alternative.

| Variant | DB MiB | Build s | Build ms/alias | Replacement median/max ms | Max build batch ms | Peak build WAL MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 1351.44 | 154.08 | 9.304 | 16.17/53.81 | 1867.38 | 127.11 |
| without_rowid | 1507.87 | 79.96 | 4.828 | 21.33/40.23 | 690.92 | 170.43 |
| drop_redundant | 948.37 | 45.48 | 2.746 | 8.07/39.34 | 375.38 | 84.76 |
| surface_once | 690.18 | 63.74 | 3.849 | 9.07/31.36 | 816.81 | 103.49 |
| integers | 189.53 | 35.55 | 2.146 | 6.41/29.56 | 399.45 | 47.79 |
| compact | 70.65 | 10.40 | 0.628 | 2.09/17.38 | 478.16 | 10.66 |
| compact_native | 70.65 | 15.80 | 0.954 | 5.30/957.82 | 616.27 | 10.66 |
| fts5_trigram | 49.93 | 3.49 | 0.211 | 3.17/407.54 | 124.41 | 3.15 |
| fts5_hybrid | 61.24 | 6.46 | 0.390 | 5.75/4803.30 | 301.10 | 7.76 |

Build cost includes complete postings and all variant indexes/dictionaries,
commits and checkpoint work, but excludes canonical graph seeding. Replacement
cost includes canonical alias text, dictionary and gram replacement in one
transaction per alias. Batch maxima are observations, not approved lease budgets.
The two compact runs have identical storage; their timing variation is retained.
Replacement maxima include 957.82 ms for the second compact run and 4,803.30 ms
for FTS hybrid. Their causes have not been isolated. These results do not show
that production writes or background batches meet the existing service budgets.

Warm query medians in ms. B=baseline, W=WITHOUT ROWID, D=drop indexes,
S=surface dictionary, I=all integer keys, C=compact adapter, N=compact native
frequency CTE, F=FTS-only, H=FTS hybrid. F† is semantically invalid for recall
and its timing cannot be claimed as an improvement. `mixed` is the first eight
characters of synthetic alias 1 (13 unique cue grams); `bigram` is its first two.

| Query/workload | B | W | D | S | I | C | N | F† | H |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all.mixed.recall.postings | 22.41 | 2.97 | 7.89 | 3.96 | 11.56 | 5.81 | 14.76 | 0.43 | 4.35 |
| all.mixed.recall.frequencies | 1009.11 | 451.95 | 831.58 | 750.15 | 1998.24 | 614.12 | 267.06 | 507.07 | 802.90 |
| all.bigram.recall.postings | 4.56 | 0.56 | 0.62 | 0.77 | 3.75 | 0.58 | 1.80 | 0.01 | 0.54 |
| all.bigram.recall.frequencies | 589.29 | 343.59 | 668.21 | 370.86 | 2147.87 | 326.08 | 194.72 | 110.33 | 883.07 |
| project.mixed.recall.postings | 8.00 | 3.16 | 7.13 | 2.22 | 7.54 | 5.34 | 12.29 | 0.15 | 22.79 |
| project.mixed.recall.frequencies | 331.28 | 202.15 | 283.41 | 132.74 | 546.88 | 175.77 | 60.54 | 58.38 | 429.14 |
| project.bigram.recall.postings | 0.71 | 0.58 | 0.61 | 0.24 | 0.48 | 0.39 | 1.90 | 0.01 | 2.19 |
| project.bigram.recall.frequencies | 145.28 | 77.03 | 129.66 | 68.21 | 145.78 | 60.94 | 28.67 | 32.04 | 174.81 |
| session.mixed.recall.postings | 6.12 | 6.44 | 6.93 | 5.45 | 6.95 | 3.56 | 7.25 | 0.15 | 16.27 |
| session.mixed.recall.frequencies | 302.07 | 251.10 | 282.67 | 288.00 | 765.31 | 227.62 | 51.68 | 62.82 | 627.18 |
| session.bigram.recall.postings | 1.00 | 0.47 | 0.68 | 0.34 | 0.48 | 0.40 | 0.42 | 0.01 | 7.34 |
| session.bigram.recall.frequencies | 136.09 | 113.38 | 122.57 | 99.36 | 202.78 | 108.31 | 26.20 | 42.54 | 247.00 |
| internal.mixed.recall.postings | 15.74 | 11.37 | 11.41 | 7.74 | 16.03 | 9.69 | 5.37 | 0.21 | 18.97 |
| internal.mixed.recall.frequencies | 968.76 | 919.37 | 771.12 | 931.93 | 2298.44 | 792.52 | 173.12 | 377.11 | 3021.28 |
| internal.bigram.recall.postings | 2.29 | 1.01 | 1.14 | 1.30 | 1.45 | 1.26 | 1.30 | 0.02 | 3.05 |
| internal.bigram.recall.frequencies | 622.06 | 528.33 | 451.48 | 667.36 | 2666.63 | 608.02 | 108.21 | 106.77 | 1137.72 |
| registration.mixed.registration.postings | 12.01 | 10.98 | 11.22 | 6.82 | 17.75 | 10.73 | 4.19 | 0.16 | 11.64 |
| registration.mixed.registration.frequencies | 773.17 | 740.25 | 809.18 | 867.93 | 2096.52 | 952.90 | 145.53 | 208.27 | 2559.88 |
| registration.bigram.registration.postings | 1.60 | 0.59 | 1.82 | 1.42 | 1.95 | 0.50 | 0.44 | 0.02 | 2.16 |
| registration.bigram.registration.frequencies | 451.14 | 446.24 | 457.13 | 387.62 | 870.79 | 443.41 | 104.86 | 79.28 | 856.77 |

All 20 workloads matched the oracle for each non-FTS-only prototype. Every
FTS-only workload failed recall equivalence while matching its asserted native
trigram result. Identity probes also covered multiple surfaces for one
node/source pair and the same surface across different pairs, including the
native alias-ID frequency CTE.


## Every posting query and access plan

The full plans for every variant, cue and scope are in the evidence JSON.
The four current statements are:

| Statement | Source | Work |
| --- | --- | --- |
| Recall candidates | [lexical.rs:105](../crates/butler-memory/src/cognition/graph/recall/semantic/lexical.rs#L105) | DISTINCT ordered node/source/surface for any cue gram |
| Recall document frequencies | [lexical.rs:139](../crates/butler-memory/src/cognition/graph/recall/semantic/lexical.rs#L139) | Eligible node/source CTE, CROSS JOIN postings, count each gram |
| Registration candidates | [selection.rs:120](../crates/butler-memory/src/cognition/graph/candidates/selection.rs#L120) | Same candidate shape, registration scope and LEFT JOIN claims |
| Registration document frequencies | [selection.rs:175](../crates/butler-memory/src/cognition/graph/candidates/selection.rs#L175) | Eligible node/source CTE, JOIN postings, count each gram |

The alias corpus size queries and exact-alias lane touch `memory_aliases`, not
postings; graph expansion does not add a posting query. Frequency counts retain
the existing DISTINCT `(node,source)` eligibility semantics, including multiple
surfaces for a pair. Never change that to counting nodes, gram occurrences, or
only returned top-ranked aliases as part of this storage migration.

Baseline candidate EXPLAIN starts with `SEARCH postings USING COVERING INDEX
sqlite_autoindex_postings_1 (gram=?)`, scans the JSON gram argument, uses indexed
source/chunk/node lookups, then `USE TEMP B-TREE FOR DISTINCT`. Recall adds four
indexed correlated claim lookups; registration has an indexed LEFT-JOIN claim.
Both baseline frequency plans materialize eligible aliases using the alias PK,
then `SEARCH postings USING COVERING INDEX idx_alias_postings_gram_source
(gram=?)` and `SEARCH d USING AUTOMATIC COVERING INDEX (node_id=? AND source_id=?)`.
Thus dropping this PK-prefix index changes a real covering access path.

The non-request alias replacement/delete predicate is also important:
[recall_index.rs:55](../crates/butler-memory/src/cognition/graph/recall_index.rs#L55),
with the same predicate in update/delete triggers at lines 19/22:
`DELETE ... WHERE node_id=? AND source_id=? AND surface_original=?`.
The baseline reverse index serves this prefix. Its compact replacement is an
alias-document UNIQUE lookup followed by `SEARCH compact_postings USING
COVERING INDEX compact_by_alias (alias_id=?)`. Retain that reverse index for
bounded deletes and FK cleanup. Insert gram checks use the primary key.

The following EXPLAIN operations distinguish the measured frequency plans;
both frequency statements have these posting accesses (their claim joins differ
as described above). See `variants.<name>.queries.<workload>.plan` for complete
plans, including candidate selection and each scope, not just these excerpts.

| Variant | Posting access / additional work from EXPLAIN |
| --- | --- |
| baseline | `SEARCH postings USING COVERING INDEX idx_alias_postings_gram_source (gram=?)` |
| without_rowid | Same index name; secondary entries carry missing PK columns |
| drop_redundant | `SEARCH postings USING COVERING INDEX sqlite_autoindex_postings_1 (gram=?)` |
| surface_once | `SEARCH p USING COVERING INDEX sqlite_autoindex_postings_1 (gram=?)`; alias dictionary `SEARCH a USING INTEGER PRIMARY KEY (rowid=?)` |
| integers | Same posting probe, plus INTEGER PRIMARY KEY lookups of `n`, `s`, `a` per posting |
| compact | `SEARCH compact_postings USING PRIMARY KEY (gram=?)`; alias dictionary INTEGER PRIMARY KEY lookup per posting |
| compact_native | `SEARCH p USING PRIMARY KEY (gram=?)`; `BLOOM FILTER ON d (id=?)`; `SEARCH d USING AUTOMATIC COVERING INDEX (id=?)` |
| fts5_trigram | `SCAN alias_vocab VIRTUAL TABLE INDEX 1:`; `USE TEMP B-TREE FOR DISTINCT`; materialized/co-routine `SCAN p`; GROUP BY temp B-tree |
| fts5_hybrid | Same vocab branch plus `UNION ALL`, compact bigram PRIMARY KEY probes, DISTINCT and GROUP BY temp B-trees |

FTS virtual-table `SCAN` labels alone do not prove a full unfiltered index scan;
the virtual-table index and bound gram constraints must be examined too. In this
prototype the native alias-ID frequency CTE avoids a dictionary lookup for each
posting and hashes/joins compact eligible IDs instead of repeated text pairs.
The broad recall frequency median improved from 1,009.11 to 267.06 ms, and the
registration frequency median from 773.17 to 145.53 ms. Candidates are not
uniformly faster: e.g. project/mixed was 8.00 ms baseline versus 12.29 ms native.
These sequential, shared-host runs do not establish a cause for that variation
or qualify every existing latency budget. FTS hybrid also has substantial
frequency regressions despite passing fixture equivalence.

## Recommended target schema

Use an alias-document surrogate, a small WITHOUT ROWID posting PK, and one
reverse posting index, with eligible alias-ID frequency probes as in
[queries.py](../scripts/alias-postings/queries.py). Keep canonical graph
node/source IDs unchanged.

```sql
CREATE TABLE memory_alias_documents(
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  surface_original TEXT NOT NULL,
  UNIQUE(node_id,source_id,surface_original),
  FOREIGN KEY(node_id,surface_original,source_id)
    REFERENCES memory_aliases(node_id,surface_original,source_id) ON DELETE CASCADE
);
CREATE TABLE memory_alias_grams(
  gram TEXT NOT NULL,
  alias_id INTEGER NOT NULL REFERENCES memory_alias_documents(id) ON DELETE CASCADE,
  PRIMARY KEY(gram,alias_id)
) WITHOUT ROWID;
CREATE INDEX memory_alias_grams_alias ON memory_alias_grams(alias_id);
```

The fixture target occupies 34.84 MiB including the dictionary and its UNIQUE
index, versus 1,315.63 MiB of legacy posting objects: **97.35% smaller**. The
complete synthetic graph is 70.65 MiB versus 1,351.44 MiB (**94.77% smaller**).
Assuming the owner's non-posting payload stays unchanged, the issue's rounded
figures suggest roughly 0.23–0.27 GiB after physical reclamation, about 83–85%
smaller overall. This is an estimate, not a measurement of owner data or a
promise that in-place shadow cutover shrinks graph.sqlite. Space is reclaimed
only when the legacy allocation is retired in a physically compact file.

The production dictionary has a composite canonical-alias FK. Graph writers
enforce foreign keys; deleting an alias cascades through its dictionary and grams.
An UPDATE trigger removes the OLD dictionary even when identity changes. The
prototype replacement measurements used the connection defaults described above.
Per-alias write cost with all target FKs enabled and the agent's actual checkpoint
policy must be included in bundled-SQLite qualification.

An alias-document identifies the full original `(node,source,surface)` tuple;
it is not a node ID or a deduplicated text-only surface. It keeps text once per
indexed alias rather than once per gram/index. NFC and folded keys remain in
canonical `memory_aliases` for exact matching. Surrogates are internal and never
exposed in rank tie breakers, provenance, JSON, graph references, or FTS scores.
Normal SQL joins return original text and preserve the current ORDER BY exactly.

Adding separate node/source/surface dictionaries remains possible but creates
three extra mapping lifecycles; the alias-document key removes those repeated
dimensions from postings together. Do not copy scope into postings: evaluate
claim/source/chunk eligibility against their latest state as today. Reuse the
existing Rust folding and grapheme generation for subsequent writes. For the
one-time copy, preserving old distinct gram strings avoids changing semantics.

For new writes, maintain the canonical alias, dictionary, and its complete gram
set in the same graph transaction. Update/delete must remove old identity grams
and dictionary entries, including source reassignment. Node scope changes need
no gram rewrite in v2 because eligibility is obtained through live joins.
Do not use SQLite's per-row update hook as the change journal for WITHOUT ROWID
tables; it does not report their updates ([SQLite documentation](https://www.sqlite.org/withoutrowid.html)).

## Production rollout, cutover and reclaim

New and rebuilt graphs use compact storage directly. Existing v1 graphs are left
unchanged by schema ensure, startup, readiness and ordinary reads. Migration is
scheduled only after the existing memory consumer finds a serving generation.
The consumer tracks the worker and cancels both queued lease waits and current
SQL work on close. The worker acquires and releases the existing consolidation
lease for each transaction, runs file/SQLite work on the blocking pool, and gives
foreground waiters time between leases. Acquisition opens the existing coordinator
read-write so SQLite can recover a hot DELETE journal after a killed lease holder;
read-only inspection remains side-effect free. A copy-only connection stays open
between batches; each batch still revalidates descriptor/mutation authority and
closes any prior physical handle after a storage change. No transaction or read
snapshot spans leases. Checkpoint-on-close is disabled on this connection, and
its blocking-pool close is awaited on completion, failure or stop.
Completed paths stay in an in-memory set;
there is no completed-worker timer, recurring DB probe, checkpoint or marker write.

Exact migration switches, read once when the consumer is constructed:

- `BUTLER_ALIAS_POSTINGS_V2=1`: enable copy and logical cutover of an existing v1
  graph. Unset, `0`, and every other value leave migration disabled.
- `BUTLER_ALIAS_POSTINGS_RECLAIM=1`: explicitly close the rollback window and
  reclaim a graph that already completed its copy. This switch is separate and
  disabled by default. It cannot initiate a copy by itself.

For read rollback before reclaim, restart the current executable with
`BUTLER_ALIAS_POSTINGS_READ_V1=1`. Reads use the still-maintained v1 table while
foreground writes maintain both shapes. This switch also blocks reclaim. Unset
it to return to v2 reads; it has no effect on fresh compact-only generations.
Do not use an older executable as this read rollback: its writers cannot maintain
v2. Restore a pre-migration backup before rolling back the executable.

Dry run: use a complete isolated copy of DATA, with an isolated HOME/CODEX_HOME,
private test port and stub/replay providers. Never launch the copy with the live
service's paths, credentials or port. First run copy with the reclaim switch
unset; compare full results and latest writes, then test reclaim separately.
No owner DATA was used to develop or measure this implementation.

The `alias_postings_v2` state is `copy`, `complete`, `reclaim`, or `fresh`.
`alias_postings_v2_cursor` records the last completed canonical alias tuple in
its PK order. A partial alias uses two small memory_state entries for its tuple
and integer document ID. Its grams resume after MAX(gram) through the reverse
index. The cursor, grams, partial markers and publication all commit together.
Each batch has a 64-KiB input byte budget including conservative per-row overhead,
not an alias-count budget. SQL cancellation rolls back the entire current batch.
An individual dictionary identity or gram larger than that budget fails safely;
no alias or gram is truncated, skipped or published partially.

Before cutover, the read view combines fully copied v2 aliases with v1 aliases
that lack a complete dictionary. The single partial dictionary is excluded from
v2 and remains served in full by v1. UNION ALL partitions alias identities, so
candidate DISTINCT/order and frequency multiplicity remain unchanged. EXPLAIN
may scan the materialized **filtered union** after both posting branches have
performed gram index probes; no base posting scan is allowed. After cutover the
view is only v2. During copy, frequency queries use the complete, still-maintained
v1 covering index; candidates read both partitions. This avoids rebuilding text
posting identities merely to count them. At the same atomic flip, frequency
queries switch to integer v2 IDs. All four queries retain complete results at
every stage. Frequency CTEs keep canonical memory_aliases and resolve integer
IDs once; their composite FK prevents stale dictionaries affecting eligibility.
Every candidate ORDER BY still uses node/source/original surface text.

Foreground apply consumes the existing memory_alias_index_dirty queue to
maintain v2 and v1 in the same transaction. There is no second journal. The OLD
document is removed on update; deletion cascades its postings. Scope stays live
in canonical joins for both read shapes; installation removes the dead legacy
scope trigger. Alias insert/update/delete maintenance remains dual through the
rollback window.
Cutover checks docs == aliases, matching v1/v2 posting counts and an empty dirty queue, swaps the read view and
state atomically, and retains dual maintenance. Foreground dispatch detects the
installed storage before installing legacy indexes, so reclaim cannot rebuild
them inside a foreground apply.

PASSIVE checkpoint results gate copying: when uncheckpointed WAL exceeds 4 MiB
(computed from the actual page size), the worker pauses new copy transactions.
Cache spilling and automatic checkpointing are disabled on its retained copy
connection. Foreground writes remain independent; this bounds migration growth,
not WAL generated by other writers. A pinned-reader E2E measures physical peak.

Reclaim runs only on the serving generation. Under one lease per object it
removes legacy maintenance, drops each of the four legacy indexes, then drops the
legacy table. Secure deletion is disabled on this connection while freeing
redundant allocation; the same text remains in canonical aliases and v2. These
DROPs release allocation but do not claim a smaller live file.

Under the final lease it calls the existing VACUUM INTO snapshot helper, syncs
the compact graph and its directory, then uses the existing full descriptor/manifest
CAS. An optional `storage_generation_id` selects only graph.sqlite in
`.storage-<uuid>` under generations. Vectors, hot caches and manifests stay in
the logical generation directory; no payload copying or projection work is needed.
The logical generation ID and every projection/cache identity remain unchanged.
Mutation authority checks the graph path too, rejecting a stale writer handle.
Generation activation carries the old storage pointer into
`previous_storage_generation_id`, and rollback restores it.
Readers already holding the old graph can finish. The old graph is retained for
owner retirement after readers drain; the generation's other files remain live.
There are no projection jobs, model calls or in-place VACUUM in reclaim.
The measured final lease duration, disk headroom and supported-platform behavior
must pass qualification before enabling reclaim.

Owner decisions: approve the isolated-copy evidence and supported-platform
qualification before enabling copy; choose the rollback-window length; separately
approve reclaim with enough space for compact graph and bounded WAL; arrange later retirement of old physical files. No switch is
enabled by this branch, and no automatic retirement is implemented.

## Rewrite evidence, risks, and enablement gates

The baseline-to-shadow copy in [rewrite.py](../scripts/alias-postings/rewrite.py)
measured 9.40 s, 130 commits of at most 128 aliases, 74.89 ms maximum batch,
9.67 MiB peak WAL, and 34.51 MiB for dictionary/postings/reverse index. It copied
the baseline after the 64 latest-state replacements, checked exact bidirectional
SQL EXCEPT equality, injected a pre-cursor rollback after five batches, closed
and reopened, and resumed with unchanged cursor/count. A completed resume
executed zero writes. Validation time and full-graph reclamation are excluded
from the 9.40 s; this is not an end-to-end live migration claim.

Peak WAL assumes no pinned reader and a PASSIVE checkpoint after every batch.
A long read snapshot can prevent recycling; production must observe checkpoint
results/WAL headroom and pause new batches without truncating content or blocking
requests. A new-generation copy also needs disk headroom for old + new + WAL and
all other graph tables, not just the measured posting dictionary. No fixture
latency is an excuse to loosen existing response or shutdown budgets.

FTS5 trigram indexes Unicode character triples, while Butler uses full Unicode
folding and grapheme bigrams/trigrams. A two-grapheme cue loses every hit in the
FTS-only prototype; combining marks/emoji can also differ in the hybrid.
External-content consistency requires explicit insert/delete maintenance, and
document frequency needs DISTINCT alias IDs rather than term occurrences.
`detail=none`/`column` and FTS MATCH ranking are not measured equivalently here;
neither can be silently substituted for the existing lexical ranker.
See [SQLite's trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
and [fts5vocab](https://www.sqlite.org/fts5.html#the_fts5vocab_virtual_table_module).

Before enablement: repeat on bundled SQLite/macOS/Windows/Linux; expand workloads
to rare/common and long multilingual cues, multiple surfaces per node/source,
Unicode folding/grapheme edge cases and all dynamic time/source predicates;
verify no full posting scan in request plans; verify foreground contention and
pinned-reader WAL; test cancellation/restart in each phase and generation
cutover/reclamation; test startup readiness, active plus queued shutdown work,
MIG-01/MIG-01b, and idle file/write stability after completion.

Production migration and reclaim now exist behind the switches above. The
measurements preceding this section are historical Python prototype evidence,
not bundled-SQLite qualification. Current validation is recorded below. The owner
must not enable based only on those historical size/latency numbers.

## Production validation

Linux x86_64 / WSL, bundled SQLite 3.50.2, base `09ffe9679`:

- `cargo fmt`, clippy (`butler-memory`, `butler-e2e`, all targets, `-D warnings`)
  and source-check passed. All 117 existing memory library tests passed.
- Stub/replay memory (6), idle memory (3), hot cache (1), migration (2),
  projection backlog (3), queue admission/shutdown (2), shutdown order (6)
  and shutdown WAL (2) passed: 25 total. MEM-05 used public local BGE-M3 assets, no model service.
  MIG-01 ran with both switches enabled and preserved the refused folder.
- The owner-scale perf E2E uses the wall-clock budget helper and checks complete
  ordered results at each stage. The final measurement is recorded below.
  The agent and harness compile bundled SQLite with
  `--config 'profile.dev.package.libsqlite3-sys.opt-level=3'`; Rust stays in the
  dev profile. This is the production SQLite library, not Python's SQLite.
- Every timed query verifies full ordered row hashes, including source origins,
  project/session/unassigned/selected scopes, active claims, conversation/event
  time bases and registration. EXPLAIN requires a gram SEARCH on **both** base
  posting branches during dual candidate reads. Three kill boundaries verify
  all migration write targets, including recovery after a killed coordinator holder.
  Completed copy/reclaim controls assert zero additional worker stages and graph
  commits; a final full-graph integrity check verifies the
  entire database separately from the migration wall timer.

macOS and Windows are not qualified on this Linux host. Before enablement the
coordinator must run these same gates there, plus cancellation during the
separate reclaim snapshot/CAS and later generation activation/rollback after
physical relocation. An owner DATA-copy dry run and safe retirement of retained
old graph files remain owner steps. No live owner file or service was touched.

Final owner fixture: 14,293 nodes, 16,561 aliases, 886,340 posting rows. All 18
ordered result hashes match before/during/after, with v1 rollback, after physical
cutover and after restart. Original wall-clock budgets remain enforced.

| Measurement | Result |
| --- | ---: |
| Migration, including 5s pinned reader, three crashes and foreground apply | 43.106s (90s budget) |
| Peak migration WAL | 4,754,512 bytes / 4.534 MiB (16 MiB test limit) |
| Broad candidate query, v1 → v2 | 9.231 → 8.646ms; 665 complete rows |
| Broad expanded-gram frequencies, v1 → v2 | 268.358 → 127.438ms; 19,297 complete rows |
| Full foreground turn plus graph apply during copy | 1.253s (6s budget) |
| Uncommitted-batch / queued-batch stop | 50.766 / 51.018ms (6s budgets) |
| Maximum SQL batch / copy lease span | 365 / 374ms |
| Maximum DROP stage lease span | 140ms; includes completion checks |
| VACUUM INTO, sync and descriptor CAS lease span | 137ms |
| Separate reclaim, including full result validation | 2.053s (30s budget) |
| Active graph, old → compact file | 1,337.324 → 66.195 MiB |
| Full-graph integrity check, outside migration timer | 10.994s; `ok` |
| 5s idle controls after copy and reclaim | 0 graph commits; 0 additional worker stages |

Lease spans include release and scheduling until the awaited leased stage returns,
so they conservatively bound the acquired interval rather than reporting SQL body
cost as lease time. The retained old 1,337-MiB file is **not** automatically deleted;
total disk usage falls only after the owner retires it with readers drained.

Intermediate runs exposed hot-journal recovery on the coordinator, synthetic gate
starvation under SQLite's 100ms busy backoff, and repeated copy connection setup
that exceeded the 90s budget under host load. Acquisition recovery, a fixture busy
handler retaining the same 2s bound, and a retained copy connection address those
causes. No timeout, response content, workload or performance budget was relaxed.
