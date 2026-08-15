# Native Agent memory attribution

Date: 2026-08-15

## Verdict

The dominant multi-gigabyte allocation is the reviewed Project Ledger publication path, not BGE-M3, vector search, web research, or provider streaming.

Before remediation, the causal path was:

```text
BTCC reviewed persistent effect
  -> applyProjectLedgerRecordUpdates
  -> prepare/promote/observe Project Ledger publication
  -> observeProjectLedgerSourceHead / inspectPublicationRoot
  -> canonicalProjectLedgerSemantics
  -> all record bodies + one complete canonical JSON string materialized together
```

This creates a large temporary JS/native allocation proportional to the complete Ledger corpus. JS objects become unreachable, but Bun's native allocator can retain the backing pages after GC. That behavior explains why Windows can retain a multi-gigabyte private working set even when live JS heap counters are small.

## Production evidence

A real reviewed `project_ledger_work_update` Turn reproduced the boundary:

- pre-effect RSS: about 313 MB
- peak RSS: 1.214 GB
- pre-effect macOS physical footprint: about 2.74 GB
- peak physical footprint: 3.328 GB
- tool-end JS heap: 469 MB
- tool-end external memory: 346 MB
- tool-end ArrayBuffer memory: 160 MB
- next model boundary: JS heap 133 MB, external memory 26 MB, ArrayBuffer effectively zero
- macOS physical footprint returned to about 2.75 GB within roughly 5 seconds
- RSS returned to about 81 MB within roughly 30 seconds

The Turn completed as `delivered`; instrumentation did not alter product behavior.

## Isolated attribution

The same guided publication operation on an APFS clone raised process RSS from 36 MB to 456 MB. A full `Bun.gc(true)` reduced live JS heap to about 2 MB but RSS remained 456 MB. Four sequential publications plateaued between roughly 398 MB and 553 MB rather than growing without bound on macOS.

Single-phase isolation on the 23 MB Butler Ledger produced these peaks:

| Phase | Peak RSS |
| --- | ---: |
| Canonical semantic serialization | 188 MB |
| Source-head observation | 227 MB |
| Directory copy | 55 MB |
| Render all generated views | 137 MB |
| Write index | 143 MB |
| Publication inspection | 275 MB |

On the 115 MB Sandy Ledger, canonical semantic serialization alone produced a 109.4 MB canonical string and peaked at 1.146 GB RSS. After full GC, RSS remained 1.137 GB while live JS heap was about 1.4 MB.

## Disproven candidates

- The preceding web-research Turn peaked below 900 MB and did not produce the multi-gigabyte boundary.
- BGE-M3/embed lifecycle did not align with either spike.
- Generic file edits, commands, recall, and provider calls did not align with the two original spikes.
- Native Project Ledger CLI output is not large enough by itself: the largest observed index JSON was about 3.6 MB.
- A cold native Project Ledger handler did not reproduce the large allocation because the production reviewed effect uses the in-process atomic publication adapter instead.

## Platform conclusion

macOS eventually reclaimed resident pages in the controlled replay. Windows retention has not been reproduced in this environment, but the full-corpus materialization and post-GC native RSS retention are platform-independent causes that make the reported 4 GB private working set credible. Remediation must bound allocation at the source; forcing GC or lowering a memory threshold is not acceptable.

## Remediation outcome

The production source-head path now sorts lightweight record descriptors and feeds one canonical semantic record at a time into the existing SHA-256 digest. It no longer retains every record body or constructs one complete canonical JSON string. The storage digest uses one reusable 64 KiB buffer, candidate publication copy uses the operating-system copy primitive, and event-log validation reads 64 KiB chunks with a fail-closed 4 MiB per-line limit.

The legacy semantic digest is unchanged. Unicode normalization, semantic metadata exclusions, record ordering, storage entry ordering, atomic publication, recovery, and idempotent replay remain covered by regression tests.

Post-remediation measurements on the 115 MB Sandy Ledger were:

| Operation | Peak RSS | Peak physical footprint |
| --- | ---: | ---: |
| Source-head observation | 274 MB | 237 MB |
| One complete guided publication | 492 MB | 303 MB |
| Six complete guided publications in one long-lived process | 539 MB | 398 MB |

After each of the six repeated publications, full-GC RSS was 520, 538, 516, 478, 521, and 515 MB. The series is bounded and non-monotonic; it does not reproduce the original multi-gigabyte allocation. GC is not required for correctness and is used here only to distinguish live data from allocator retention.

An initial three-steady run was not reproducible: one independent run rose from 308,233,536 to 395,412,824 physical bytes. The acceptance contract was therefore strengthened rather than the threshold being relaxed. Three samples are now incomplete evidence. The gate requires one warmup plus six steady publications, compares the first-three and final-three medians, rejects more than 10% median growth, and independently rejects strictly positive monotonic growth.

The independent six-steady gate used a 107,437,797-byte clone with 3,791 records. A separate parent sampled the long-lived publication child every 250 ms, so the result includes in-cycle peaks rather than only after-operation memory. The steady physical-footprint series was 324,322,648, 356,566,384, 332,055,920, 316,147,056, 322,487,664, and 326,583,688 bytes. The first-three median was 332,055,920 bytes; the final-three median was 322,487,664 bytes; the ratio was 0.971. The 768 MiB macOS gate passed with no failure codes.

The same runner selects Linux private resident memory or Windows `WorkingSet64` by platform. Windows additionally requires `PrivateMemorySize64`; either Windows counter exceeding 768 MiB fails the gate. Missing counters or an unexecuted platform are `unavailable`, never inferred as passing.

## Remediation status

1. Complete: compute the canonical semantic digest incrementally, one sorted record at a time.
2. Complete: hash storage files with a reusable bounded buffer.
3. Complete: copy publication files without parent-process whole-file Buffer materialization.
4. Complete: line-bounded streaming validation for the Ledger event log.
5. Complete: exact source/storage hashes and atomic publication/recovery/idempotency regressions.
6. macOS complete; Windows remains blocked pending repeated-run Working Set and Private Commit evidence from a Windows host.

## Residual limit

The privacy-safe phase instrumentation is complete and default-off. The source allocation defect is remediated and the macOS large-Ledger gate passes. The Windows before/after gate is still required; this report does not claim Windows acceptance or final Work completion.
