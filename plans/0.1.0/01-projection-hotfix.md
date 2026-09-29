# 01. SSD write hotfix: transcript projection (P0)

**Start from:** `claude/projection-quadratic-fix`. The draft PR body says which parts are done. Ship a MINIMAL hotfix PR first; the performance follow-ups go in a second PR.

## Context
Root: `crates/butler-gateway/src/gateway/application/projection/`. On the owner's machine the idle agent used 100–200% CPU and about 440 MB of RAM, and wrote about **3.5 GB/min** to the SSD. Four bugs combine to cause it.

1. **`trailing` grows without bound.** In `byte_window.rs:30-45`, `read_record` always reads another 64 KB window and appends it to `trailing`, consumes one record, and keeps the rest (line 41). So `trailing` ends up holding the rest of the file, and one checkpoint row reached 85 MB.
2. **Every record rewrites the whole checkpoint.** Each record loads the checkpoint, base64-decodes `trailing`, encodes it again, and upserts the row (`transcript_file.rs:24-66`, `checkpoint.rs:39-69`). The decoder in `checkpoint.rs:127-133` looks each byte up in a 64-entry alphabet with a linear scan.
3. **Checkpoint identity includes the device id.** `byte_window.rs:~133` compares `file_device`, but macOS device ids change: August checkpoints hold 16777230 and the same files now report 16777233. About 300 fully projected chats restarted from byte 0.
4. **Sweeps are too broad, and saves happen when nothing changed.**
   - `owner.rs:83-88` maps any change under `runtime/inbound-events/{processed,failed}` to `Command::Terminal`, which starts a full sweep of all ~616 chats (`owner.rs:309-371`).
   - The settle step writes a tmp file and renames it, which fires several events, and `resweep` doubles the sweep. That is about 2 full sweeps per settled item.
   - `sync_chat_once` saves the checkpoint even when nothing changed (`transcript_file.rs:56-64`).

## Hotfix steps (PR 1)
1. `byte_window`: stop reading a new window while `trailing` already contains a complete record. Bound `trailing` to one window plus one partial record.
2. Load repair: if the stored `trailing` is larger than 128 KB, discard it and re-read the file from `projected_bytes`. The next read starts at `projected + len(trailing)`, so discarding it is safe; verify that invariant in code. This repairs the owner's rows automatically, with no manual DB edits.
3. Identity: drop `file_device`. Keep path, inode, size and the anchor bytes at `projected_bytes`. If the anchor matches, resume. A mismatch must never silently restart a fully projected file from zero unless the anchor actually differs.
4. `sync_chat_once`: return early without saving when identity, size and mtime are unchanged and there is no trailing or spool data.
5. `Terminal`: sweep only chats that have non-terminal turns or staged rows. Reuse the `open_turn_transcripts` query in `owner/files.rs:16`. Ignore `*.tmp` paths in the watcher.
6. Index: existing DBs have no `turns(state)` index, because it is created only for new DBs (`storage/schema.rs:26-30`). Add it, or a partial index on the non-terminal states.

## Follow-up (PR 2)
- Project all complete records in a window per step, and save once per batch in one transaction.
- Replace the hand-rolled decoder with the `base64` crate, or store `trailing` as a BLOB. Keep reading the legacy format.
- Throttle background sweeps with a budget or sleep between batches.
- Give UI reads their own read-only connection (WAL). The prerequisite is publish-after-commit; see plan 07. Today every UI read queues behind projection on the single `butler-app-sqlite` lane (`storage.rs:41`).
- Reap the embedding worker after 10 minutes idle (`host/embedding/owner.rs` loop, lines ~280-300).

## Acceptance
- **E2E, stub tier:** generate a 20 MB transcript with thousands of records, plus a pre-seeded 5 MB legacy checkpoint row with a different device id.
  - Projection completes, and the stored `trailing` is at most 128 KB afterwards.
  - A fully projected chat whose device id changed is not re-projected: its row write count stays the same.
  - A settled inbound item does not rewrite the checkpoints of unrelated chats.
- **Live check (plan 13):** with the service idle for 10 minutes after the upgrade:
  - disk writes ≈ 0;
  - CPU < 5%;
  - footprint < 100 MB;
  - the App DB WAL stays < 64 MB.
