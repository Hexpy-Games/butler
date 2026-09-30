# Idle read and memory regression investigation

Measured on Linux x86_64, release mode, in a disposable data directory and
installation. No installed Butler data or services were used. Baseline source:
`3fc5dc534` (main, containing `94f51040`). The requested older `b572e90f`
object was absent from local and freshly cloned remote history; fetching that
ref also failed, so no older-build comparison is claimed.

## Reproduction and attribution

The larger PERF-01 variant had 600 chats, 5,000 terminal turns and 300,000
App events (1,426,526,208 database bytes), 888,000 metric records and 30,000
completed memory windows. Adding 30,000 non-recovery canonical message rows
made the minute-by-minute inventory scan visible. Samples came from procfs
`smaps_rollup` and `io`; `strace -f -yy -e trace=openat,read,pread64` identified
the files. After two minutes of settling, three 60-second windows were sampled.
The canonical rows were added during the first baseline window; the last two
baseline windows include the full recurring scan. All three after windows
include the same rows.

| Counter | Before (full-data windows) | After (three windows) |
| --- | ---: | ---: |
| RSS, KiB | 202,940–203,092 | 72,104–72,144 |
| PSS, KiB | 199,234–199,346 | 68,373–68,413 |
| `rchar`, bytes/60 s | 12,085,068–12,085,069 | 55,116 |
| `read_bytes`, bytes/60 s | 0 | 0 |
| `write_bytes`, bytes/60 s | 0 | 0 |

Zero `read_bytes` does not imply zero reads: the kernel cached the fixture.
The trace attributed 12,054,628 bytes in a recurring catch-up pass to
`runtime/conversation-store.sqlite`. A caught-up consumer still called
`read_recovered_source_page` every minute. Its cursor records the last eligible
recovered/imported message, so trusted messages after that cursor (or a store
with no eligible messages at all) were repeatedly inspected. Catch-up already
recorded source identity, public revision and sweep completion, but never used
those facts to skip an unchanged inventory. It now does, preserving full scans
for crash recovery, invalid cursors, replaced stores and legacy sources whose
identity cannot establish freshness. Source revision changes still run catch-up.

The memory root cause was App SQLite tuning introduced by `7327235b9`:
a 64 MiB page cache plus a 256 MiB mmap allowance. The baseline's detailed
`smaps` had **94,912 KiB resident in the App database mapping**, plus
42,080 KiB in anonymous mappings. After disabling mmap and bounding the page
cache to 8 MiB, the App mapping was absent and anonymous mappings were about
5,752 KiB. Executable mappings remained about 58,500 KiB. This directly locates
the retained memory; changing Tokio runtimes or trimming returned content was
unnecessary. Linux RSS after the fix is about 74 MB, including executable pages.

## Coverage and limits

The `idle_resources` perf-tier E2E shares the PERF-01 seed with larger event
bodies, seeds valid trusted canonical messages with parts and large metrics,
and checks three idle windows against 100 MB RSS and 1 MB/minute read budgets.
It checks row counts, terminal projections, the latest seeded message body and
metric-file size after each window. The ordinary PERF-01 replay checks complete
session content, ordering, freshness, delivery latency and retention behavior.
Memory idle E2Es check unchanged graph/lock files, crash recovery and catching a
changed imported source without restarting the process.

The synthetic run did not construct a 6.6 GB BTCC database or the owner's complete
transcript set. It reproduces the two identified causes, but Linux RSS/PSS are
not macOS `phys_footprint`; an owner-machine confirmation remains necessary to
establish the exact macOS result. No such installation was touched here.

PERF-01 after the cache change: empty delivery 512.6 ms, owner-scale delivery
511.2 ms, session-view p95 3.7 ms, restart readiness 105.9/106.1 ms and retention
settling 410.1 ms. All complete-content and retention assertions passed. The
memory idle suite passed all three scenarios: changed-source ingestion, crash
recovery and zero graph/WAL/lock changes during the idle window (zero leases).

The larger shared-seed PERF-IDLE E2E also passed: RSS
86,859,776–86,863,872 bytes, PSS 83,063,808–83,067,904 bytes and `rchar` 55,110
bytes per window, with zero storage reads in all three windows. This seed also
has uncompacted progress to settle and native message parts; it is a separate
fixture from the traced before/after run above.

## macOS catch-up deadline correction

PR #361 failed in macOS CI run 36689806731, job 109804121254, at the
unchanged 75-second changed-source deadline. The original stub E2E also failed
on this Mac twice (86.88 seconds for the second run, excluding build time).
The isolated canonical database retained revision 1 and the complete imported
message, while the graph had no saved catch-up cursor.

A temporary diagnostic build reproduced the failure in 85.14 seconds. After
the initial empty-source pass (revision 0), subsequent due checks observed
elapsed times of 4.005, 12.010, 28.021 and 58.027 seconds. All were below the
60-second catch-up interval, so none read the new revision. The next idle
backoff was 30 seconds: the next eligible poll would be about 88 seconds after
the first pass. The graph's initialization timing determined the phase of
these two independent timers; this is a portable scheduling defect exposed on
macOS, rather than a filesystem timestamp or SQLite WAL freshness defect.

The host now bounds a successful idle poll's backoff by the consumer's next
catch-up deadline. The same interval governs admission and sleeping. Missing
generations, errors and deferred work retain their existing backoff, avoiding
an overdue-deadline busy loop. Source identity/revision comparison and the
unchanged-inventory skip remain intact. No timestamp, inode, data-version or
platform-specific notification is used for canonical freshness. Diagnostic
logging was removed from the final implementation.

The native resource sampler now exposes macOS physical footprint and disk-read
bytes through libproc, inside `butler-platform`. macOS does not expose Linux's
`rchar` or PSS through this API; these are explicitly unavailable, never zero.
The owner-scale E2E checks the same 100 MB footprint and 1 MB/minute disk-read
budgets and retains every content-preservation assertion. Linux still checks
RSS and cached-read-inclusive `rchar` and reports PSS as before. A cached-read
trace on this Mac requires administrator access; `sudo -n` reported that a
password was required, so no cached-read-byte measurement is claimed here.

Validation on this Mac after merging `origin/main` (`15c4b5fb7`, including
#360): the unchanged changed-source E2E passed once through nextest and 30
times through its current compiled test executable (six independent loops of
five, each with a fresh HOME/BUTLER_DATA and the same rebuilt agent). Catch-up
after the external commit took 57,562–60,128 ms. The complete `memory_idle`
group passed all three scenarios; graph commits, graph/WAL/lock changes and
idle leases were all zero, with zero writes after crash recovery settled.
Formatting, Clippy with `--all-targets -D warnings` for butler-agent,
butler-memory, butler-platform and butler-e2e, and source-check all passed.
The test's 75-second deadline and every correctness assertion remain unchanged.

The subsequent main update `e198f92f6` (#362) was also merged before pushing;
it changed only release workflows/documentation, with identical tested Rust
sources. The isolated optimized owner-scale PERF-IDLE run passed in 326.21 s:

| macOS 60-second window | RSS, bytes | Physical footprint, bytes | Disk read bytes |
| --- | ---: | ---: | ---: |
| 0 | 35,028,992 | 31,736,624 | 12,288 |
| 1 | 35,192,832 | 31,802,160 | 0 |
| 2 | 35,028,992 | 31,802,160 | 65,536 |

All three windows passed the unchanged 100 MB/1 MB-per-minute budgets and
complete-content assertions. These native macOS disk-I/O counters are not a
measurement of Linux `rchar`, so the original 55 KB/minute cached-read result
is not claimed as reproduced on this Mac. Apple exposes the disk counter as
[`ri_diskio_bytesread`](https://developer.apple.com/documentation/kernel/rusage_info_v3/1577522-ri_diskio_bytesread).
The release build succeeded with one existing release-only `unused_mut`
warning at `crates/butler-agent/src/host/service/ingress/bind/policy.rs:307`;
the required all-targets Clippy run used the debug profile and had no warnings.

Pre-commit ran with isolated HOME/BUTLER_DATA. Its Bun lint passed (13 existing
warnings); typecheck failed because this worktree lacks React, Zustand and
ts-morph dependencies. No TS/UI source changed. The commit used the explicitly
authorized environment-failure `--no-verify` bypass; no TS check success is
claimed.
