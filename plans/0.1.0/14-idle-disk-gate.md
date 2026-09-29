# 14. Idle disk-write CI guard (P0)

**Start from:** `origin/main`.

## Context

An idle agent once wrote about 3.5 GB per minute to the owner's SSD. The
projection fix addresses that bug, while this gate prevents a recurrence in
the stub E2E tier on macOS and Linux.

## Acceptance

- The platform crate reports cumulative process disk bytes read and written,
  plus CPU time, on macOS and Linux; unsupported hosts return a typed error.
- IDLE-DISK starts a real agent on generated chats, completed turns,
  transcripts and memory files. After readiness and a short grace, 60 seconds
  of idle activity writes at most 1 MB and averages at most 2% CPU.
- The 30 seconds after a completed replay turn writes at most 5 MB.
- The test prints the counters and, on a budget failure, changed data-dir
  files with old and new sizes. Both stub CI jobs execute the scenario.
