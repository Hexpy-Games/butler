# 07. Cheap read-path wins before 0.1.0 (P1)

These are low-risk, high-impact items from the performance audit. The draft PR on branch `claude/perf-app-storage` may already contain some of them; check its body.

Paths below are relative to `crates/butler-gateway/src/gateway/application`, abbreviated `G/`.

## Steps
1. **Use the partial index.** `events_turn_id_idx` is partial (`WHERE turn_id<>''`), so SQLite only uses it when the query carries that predicate.
   - Add `AND turn_id<>''` to:
     - `G/projection/final_turn_events.rs:60` (measured 226 ms warm / 938 ms cold, down to 0.03 ms; runs 3–4× per delivered turn);
     - `G/progress_view.rs:67` (measured 7.8 ms / 332 ms, down to 0.03 ms; runs about 110× per session-view);
     - `G/retry/source.rs:324`;
     - `G/queue.rs:349`.
   - Verify each change with EXPLAIN QUERY PLAN.
2. **App DB pragmas** (`G/storage.rs:207-220`).
   - Set `cache_size=-65536`, `mmap_size=268435456`, `temp_store=MEMORY` and `journal_size_limit=67108864`.
   - Run `PRAGMA optimize=0x10002` at open. Also run `PRAGMA optimize` every few hours and on close.
   - Run `wal_checkpoint(TRUNCATE)` when idle.
   - Set `set_prepared_statement_cache_capacity(256)` and use `prepare_cached` on hot SQL: events append, queue, retention, progress_view, read_model, sessions.
3. **Partial indexes.**
   - `session_queued_messages(state,chat_id) WHERE state IN ('queued','dispatching')`
   - `app_automation_runs(state) WHERE state='queued'`
4. **Gate startup-only full scans behind `user_version`:**
   - the FTS backfill (`storage/schema/supporting.rs:58-60`);
   - the `updated_at` backfill (`migration.rs:186`);
   - `settle_ended_turn_messages`.
5. **Retention startup sweep** (`G/retention.rs:94,160`, `retention/compaction.rs`). It re-compacts every terminal turn on every start, which takes about 20+ minutes.
   - Persist a watermark, and select only turns that still need work.
   - Skip the upsert when nothing changed.
   - Raise `DELETE_BATCH` from 8 to 256.
6. **Throttle `/work-status` in the UI.** `useWorkStatus.ts:24` refreshes on every live event. Debounce it to 1–2 s with a single request in flight.
7. **Clean up the inbound queue.** `settle` leaves `processing/*.json.done` tombstones (3,014 on the owner's machine), and a 500 ms poll lists them twice per tick (`inbound_queue/storage/settlement.rs:70`, `io.rs:65-81`).
   - Delete the tombstones or move them into `archive/`.
   - Prune `processed/` by age.
   - Run queue calls in `spawn_blocking`.

## Acceptance
- An E2E seeds an owner-scale App DB (200k events, 5k terminal turns, 500 chats) and checks:
  - final projection per delivered turn completes in under 20 ms;
  - a second startup performs no retention re-compaction;
  - `/session-view` p95 is under 150 ms.
- A `format-pin` test runs EXPLAIN on the four queries and asserts they contain no `SCAN events`.
