# Active-generation hot cache refresh

The live completion consumer advances `generation::cache::advance` after each
semantic quantum, before vector work. Embeddings are not required. Each pass
claims one durable pending cache job under the existing consolidation lease;
there is no new writer, dirty set, receipt hash, timer, or shutdown waiter.

The long-lived read-only probe first checks for `idx_jobs_hot_cache`. If absent,
it requests one background stage without scanning jobs. The stage creates the
expression index with `CREATE INDEX IF NOT EXISTS`, never at repository open or
startup readiness. A cancellation observer uses SQLite’s interrupt handle,
including during sorting; a progress handler also checks every 1,000 VM
instructions. The observer is dropped when creation ends, without an extra
shutdown wait. Interrupted creation rolls
back and is retried at the next start. Generation/data authority is checked before
any write, including index creation. The index excludes non-JSON historical stage
values, avoiding expression errors on old settled fixture rows.

With the index present, the probe and claim seek pending/running states. Running
recovery processes at most one job per pass. Semantic completion, not vector
completion, gates cache admission. Identity invalidation uses graph evidence to
re-pend jobs without vector units; typed removal and internal supersession also
re-pend affected jobs. Retired revisions run a cleanup-only refresh.

The stage resolves active canonical evidence from the live conversation store
(building generations retain their snapshot). It validates physical retained
entries plus candidate windows through the same evidence reader as the prompt.
Valid migrated entries survive without outcome rows. Rebuild-only inventory
reconciliation remains limited to rebuilding generations.

All windows render in memory with the existing admission, ordering, scope,
evidence and 20 KiB policy. A job replaces the cache at most once, only if the
final body differs. Empty jobs still prune invalid entries. Generation authority
is rechecked before publication and before the completion receipt. Cancellation
is checked immediately before publication: work not published is re-pended;
a started publication completes temp write, fsync and rename on the leased
blocking pool, then records its receipt. The existing consumer close path waits
for that task within the existing stop grace. Crash replay after rename recomputes
the same bytes and avoids a replacement.

The stub regression waits for the first job's completion and verifies the fact
is installed before restart. It also removes outcome rows and window summaries
to exercise migration retention through the real stage, checks all pending work
drains, and requires another chat's actual hot-cache document to contain the fact.
An existing in-process lifecycle test checks the probe/claim query plans use the
new index and do not scan projection jobs. It also cancels an index build
after SQLite begins CREATE INDEX and checks rollback preserves all rows.

## Cost measurement

No 1.6 GB graph fixture was found in this worktree, `/tmp`, or the build cache.
The existing perf-tier memory seed generates 30,000 settled jobs/windows rather
than a 1.6 GB graph. Index creation time and WAL growth at 1.6 GB remain unmeasured;
they cannot be inferred from database bytes alone. The actual perf seed
(10,805,248-byte graph) measured 3.051 ms creation and 12,392 bytes of WAL growth.
Its historical non-JSON complete states are excluded, so these numbers describe
an empty index and must not be extrapolated to the owner graph. Repeating with
valid JSON complete states on a fresh isolated seed (11,563,008 bytes) measured
11.766 ms and 1,540,912 bytes WAL growth for 30,000 indexed jobs; all job/window
counts remained 30,000. This also is not a 1.6 GB measurement. Per-job cache publication is
bounded by the existing 20 KiB policy; physical fsync/WAL amplification is not
estimated as that logical size.

To measure once on an **isolated writable copy** of an owner-scale fixture, from
the Rust workspace (never point this at a live/refused data folder):

```sh
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
python3 - /path/to/isolated-fixture/graph.sqlite <<'PY'
import os, sqlite3, sys, time
path = sys.argv[1]
db = sqlite3.connect(path)
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA wal_autocheckpoint=0')
assert not db.execute("SELECT 1 FROM sqlite_schema WHERE name='idx_jobs_hot_cache'").fetchone()
size = lambda: os.path.getsize(path + '-wal') if os.path.exists(path + '-wal') else 0
before = size()
start = time.monotonic()
db.execute("CREATE INDEX IF NOT EXISTS idx_jobs_hot_cache ON memory_projection_jobs(json_extract(hot_cache_state,'$.state'),last_served_at IS NOT NULL,last_served_at,created_at,job_id) WHERE json_valid(hot_cache_state)")
db.commit()
print(f'graph_bytes={os.path.getsize(path)} creation_seconds={time.monotonic()-start:.3f} wal_growth_bytes={size()-before}')
db.close()
PY
python3 - <<'PY'
import os, shutil
for key in ['HOME', 'BUTLER_DATA']:
    path = os.environ[key]
    assert path.startswith('/tmp/')
    shutil.rmtree(path)
PY
```
