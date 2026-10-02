# Box retirement

Box is abandoned. Generated files remain under `<data>/artifacts/generated`,
and existing artifact registrations and project dashboard reads are unchanged.
No migration, deletion or cleanup of `<data>/cognition/box` is performed.

## Inventory and reachability

References below describe the source immediately before this removal (the parent
of the retirement commit), unless marked retained.

| Code | Production reachability | Decision |
| --- | --- | --- |
| `butler-agent/src/host/memory_jobs/daily.rs:84,115,125` | Constructs Box for the scheduled daily cycle and legacy integrity service | Remove construction and dependency |
| `butler-agent/src/host/memory_jobs/consolidation_phase.rs:40,126` | Daily index rebuild and retention | Remove both phases |
| `butler-memory/src/cognition/consolidation/types.rs:22,32,43,48` | Phase scheduling and serialized phase names | Remove Box phases |
| `butler-memory/src/cognition/box_store.rs:27,48,54,68` | Index/retention and manifest-existence checks; no ingestion API | Delete service |
| `butler-memory/src/cognition/box_store/{index,index_io,manifest,paths,retention}.rs` | Maintenance implementation: SQLite rebuild, manifest validation, retention and path guards | Delete |
| `butler-memory/src/cognition/box_store/operator.rs:56` | Exported library operators without a Rust CLI, tool or answer-time caller | Delete all 262 lines |
| `butler-memory/src/cognition/box_store/tests.rs` | Box-only index, retention, security and operator tests | Delete; no separate Box fixtures |
| `butler-memory/src/cognition/error/codes.rs:129` and `wire_codes.txt:124` | Box operation error strings, with format-pin coverage | Remove 22 Box codes and pinned strings |
| `butler-memory/src/cognition/legacy/metadata.rs:261,341,371` | Daily integrity validation, library link repair | Stop querying/validating/deleting Box links; keep feedback validation and repair |
| `butler-memory/src/cognition/memory_health/format_pin.rs:54` and its health fixture | Example failed phase only; no dedicated Box health reader | Use a remaining phase in the fixture |

No Rust CLI/status/health fields or i18n strings beyond these phase metrics and
error codes refer to this feature. Rust's `Box<T>`, CSS box sizing, hostname
fixtures and update artifacts are unrelated. No prior document in this docs
folder described Box.

## Retained live contracts

- `butler-memory/src/cognition/legacy/metadata/inspect.rs:43,121` returns old
  memory Box IDs and relations as opaque strings. It never opens Box storage.
  Integrity counts/reports and repair reports no longer contain Box fields.
  Box refs are neither validated nor removed; feedback behavior is unchanged.
- `butler-memory/src/cognition/knowhow_store/document.rs:197` preserves
  `box_item_ids` and unknown evidence fields. Know-how has no Box resolver or
  store dependency; its tests and format fixtures remain. Know-how is deferred
  under #456, not removed.
- `butler-memory/src/cognition/generation/initialize.rs:148` and
  `generation/initialize/empty.rs:38` still check dormant-directory occupancy
  for initialization safety. Generation is explicitly outside this task's
  scope; these are not daily-cycle reads or writes.
- `butler-e2e/tests/memory.rs:292` retains the old-folder refusal fixture.
- `butler-turn/src/workspace/commands/environment.rs:44` still provides the
  generated artifact directory. Artifact registration/dashboard code is untouched.

The removed weather producer is verified in history: commit
`6fbf48f9aefefaec82a1558f9e53e59de70de466` (2026-06-16). Its parent contains
`packages/butler-agent/src/agent/cognition/weather-knowhow.ts:451`, which
creates a Box snapshot. Current Rust has no Box artifact-event append/ingest
path or answer-time item consumer. The owner's reported 22 files and last-write
observations were not independently verified: this task never accesses live data.

The existing hot-cache daily-cycle E2E seeds a dormant Box directory after
initialization, waits for successful scheduled-cycle completion, then compares
all relative paths, bytes and modification times. This includes an invalid index
and an expired item; maintenance must leave both alone.
