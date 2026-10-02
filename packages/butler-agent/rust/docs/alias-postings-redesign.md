# Alias posting storage: issue #435

Measured on 2026-10-02, branch `codex/alias-postings`, base `53fa0a313`.
Scope: synthetic measurement, schema prototypes, and migration design. No runtime,
recall ranking, expansion, startup, or shutdown code changes. Do not enable a
migration from this document without reviewing the cutover and reclamation plan.

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
CREATE TABLE memory_alias_documents_v2(
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES memory_nodes(id),
  source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),
  surface_original TEXT NOT NULL,
  UNIQUE(node_id,source_id,surface_original)
);
CREATE TABLE memory_alias_postings_v2(
  gram TEXT NOT NULL,
  alias_id INTEGER NOT NULL REFERENCES memory_alias_documents_v2(id)
    ON DELETE CASCADE,
  PRIMARY KEY(gram,alias_id)
) WITHOUT ROWID;
CREATE INDEX idx_alias_postings_v2_alias
  ON memory_alias_postings_v2(alias_id);
```

The fixture target occupies 34.84 MiB including the dictionary and its UNIQUE
index, versus 1,315.63 MiB of legacy posting objects: **97.35% smaller**. The
complete synthetic graph is 70.65 MiB versus 1,351.44 MiB (**94.77% smaller**).
Assuming the owner's non-posting payload stays unchanged, the issue's rounded
figures suggest roughly 0.23–0.27 GiB after physical reclamation, about 83–85%
smaller overall. This is an estimate, not a measurement of owner data or a
promise that in-place shadow cutover shrinks graph.sqlite. Space is reclaimed
only when the legacy allocation is retired in a physically compact file.

The proposed dictionary node/source FKs above add integrity checks not present
in the prototype's alias dictionary. Its posting FK is enforced during builds,
but replacement probes use the reopened connection defaults described above.
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

## Online, resumable migration plan

This is a proposed implementation contract. The standalone SQL copy experiment
does not implement the runtime lease, dirty journal, readiness or cutover.

1. After existing legacy-data validation and readiness, schedule an explicit
   background operation behind a disabled feature/config gate. Refused legacy
   data must not create a DB, WAL, migration marker, directory, lock, or trigger.
   Preserve [storage_bootstrap.rs:44](../crates/butler-agent/src/host/runtime/storage_bootstrap.rs#L44)
   and [graph/schema.rs:13](../crates/butler-memory/src/cognition/graph/schema.rs#L13)
   refusals. MIG-01 at [migration.rs:24](../crates/butler-e2e/tests/migration.rs#L24)
   must still assert an identical refused directory tree.
2. Acquire the existing consolidation write lease in `Background` wait class,
   with a CancellationToken, for one bounded step. Use the pattern in
   [generation/stage.rs:47](../crates/butler-memory/src/cognition/generation/stage.rs#L47)
   and its `spawn_blocking`/release wrapper at line 70; assert the lease/fence and
   active generation before each mutation. Do not introduce a second lock or
   hold the lease across the entire migration or sleep between batches.
3. Persist format, source generation/revision, phase, last canonical alias
   `(node_id,surface_original,source_id)` and completion state. The source alias
   PK supports keyset pagination; never OFFSET or repeatedly scan all postings.
   Install change-driven dirty capture for insert/update/delete of aliases and
   folded text, including both old/new tuple keys. Canonical writer commits and
   dirty capture must be atomic. Do not register timer-driven rescan/backfill.
4. Create v2 shadow tables, keep legacy reads and writes authoritative, then
   backfill keyset batches. The prototype uses 128 aliases (~6,850 postings) per
   commit, but production needs an additional posting/byte bound and measured
   foreground service budget. Persist the next cursor in the SAME transaction
   as copied grams. Alias replacement/deletion before its turn is reconciled
   from current canonical state under the lease. A rollback replays that batch.
   Drain/coalesce dirty aliases in bounded batches with the same rules.
5. Check cancellation between aliases and through rusqlite's progress handler
   within SQL. Bound individual alias work too: if an alias exceeds a batch's
   byte/gram allowance, stage its grams over resumable sub-batches and publish
   its complete dictionary entry atomically when done. Never publish partial
   grams or truncate an alias. Use zero/short busy waiting in background work,
   yielding to foreground writes instead of the graph's normal 5-second timeout.
6. Validate all aliases and both directions of posting equality in bounded
   ordered/hash ranges, with per-range dirty revision checks. Reconcile latest
   source revisions, deletes, scope and claims; verify all four SQL result sets,
   tie ordering and latest-state recall against the legacy path. Do not run a
   whole-graph EXCEPT scan under one production lease as the harness does.
7. With a short final lease, ensure catch-up is empty/current, flip an atomic
   format marker and route ALL reads/writes to v2 together. Coordinate with the
   concurrent recall work; storage is below its ranker. Change
   [apply.rs:87](../crates/butler-memory/src/cognition/graph/apply.rs#L87) and line
   114's [install_and_backfill](../crates/butler-memory/src/cognition/graph/recall_index.rs#L9)
   dispatch so it cannot recreate old indexes, triggers or pending backfills.
   A reader transaction uses one schema version. Before cutover, cancellation
   leaves v1 authoritative; after it, all writer paths must maintain v2.
8. Logical cutover alone does not shrink a rowid database. Do not claim freed
   pages as reduced file size and do not VACUUM, DROP large indexes, or delete
   886k rows in startup/shutdown. Preferred physical reclamation is a new graph
   generation built in the background without the legacy posting objects.
   Copy other tables/indexes without changing canonical IDs or payloads, using
   bounded PK batches and a durable change journal for EVERY copied graph table
   (jobs/windows/vector state as well as aliases). Replay dirty keys and preserve
   unknown schema/payload or fail safely before switching. Qualify the target
   using the existing generation manifest/descriptor CAS pattern in
   [cutover/activate.rs:147](../crates/butler-memory/src/cognition/generation/cutover/activate.rs#L147).
   Readers pin their generation; retain the old file until no readers/writers
   can reference it, then retire it outside readiness/shutdown. This makes the
   physically compact file authoritative without a live whole-file VACUUM.
9. Completed state unregisters the worker and journal/dual-maintenance triggers;
   ordinary graph mutations only maintain v2. Reopen checks the completion
   marker read-only. No timer, periodic checkpoint, marker refresh or idle
   write. Shutdown cancels queued lease waits and in-flight batch work and
   does not join an unbounded copy/reclaim operation.

The physical-reclamation step still needs design review: journaling every graph
writer, schema preservation, descriptor qualification, reader pins, and safe
retirement have not been prototyped here. Automatic VACUUM is not a substitute:
[SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) can require substantial
temporary disk and a long operation, and changing existing auto_vacuum=NONE to
incremental requires rebuilding first ([PRAGMA documentation](https://www.sqlite.org/pragma.html#pragma_auto_vacuum)).

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

Production migration/schema code is deliberately left unimplemented. The
storage direction is promising; the physical online transition and full recall
latency qualification are not yet unambiguous. This satisfies the task's
doc-plus-benchmark stop condition and leaves recall changes to their session.

## Checks and delivery

- Owner-scale harness: nine variants, 20 complete workloads each, first plus
  three timed repetitions; eight variants passed recall equality, FTS-only
  passed native correctness but intentionally failed recall equality.
- Supplemental identity/Unicode probe: passed for all nine variants; it proves
  FTS's combining-mark mismatch and retains full alias frequency multiplicity.
- Evidence verification: all 180 records have plans and valid source references;
  non-FTS-only result hashes exactly match baseline; latest-state results and
  rollback/resume checks pass. All Python files/functions meet 500/80-line limits.
- `cargo fmt --all`, `cargo clippy -j 8 -p butler-source-check -- -D warnings`,
  and `cargo run -j 8 -p butler-source-check -- .`: passed from the Rust workspace
  with its pinned Rust 1.91 toolchain and fresh HOME/BUTLER_DATA.
- `bun install --frozen-lockfile --ignore-scripts && bun run check`: passed in
  isolation with the host's existing Bun 1.3.11 binary added to PATH.
- Initial command setup failures were corrected: root-directory Cargo selected
  Rust 1.98 and scanned node_modules; Bun initially was absent from PATH. The
  first fixture seed also had a SQL placeholder count error, fixed before the
  complete baseline measurement. No tests/budgets were weakened or retried to
  conceal a failure.
- No agent/runtime crate was changed or built, and runtime E2Es including MIG-01
  were not run. They remain explicit enablement requirements above. Delivery is
  a pushed branch without a PR; coordinator CI is outside this task.
