# 04. Usage and Updates latency (P1)

**Start from:** `claude/usage-updates-latency` (draft PR).

## Context (measured on the owner's machine)
- **`/usage-monitor` takes 7–10 s per call.**
  - It parses all 2,440 transcripts (1.5 GB) every time: `butler-runtime/src/operations/status_summary.rs:42` and `context/status_transcript_activity.rs:58-90`.
  - It then discards the result for 24h, 7d and per-session queries (`status_summary/usage/availability.rs:67,75`).
  - It runs synchronously on a tokio worker (`butler-agent/src/host/app/monitoring.rs:100`).
  - It waits up to 2.5 s on quota polling (`monitoring.rs:95`, `monitoring/quota.rs:26`).
  - The session query used by the composer popover (`useConversationUsage.ts:9`) returns 674 KB of global, all-time totals.
  - Every call also parses `prompt-cache-usage.jsonl` (33 MB) in full.
- **`/updates` fetches the GitHub manifest on every GET**, with no cache and a 60 s timeout (`butler-runtime/src/operations/update.rs:51-53,79`). It then writes `status.json` with fsync. The App also sends a POST check on every bootstrap.

## Steps
1. **`/usage-monitor`**
   - Scan transcripts only when neither a session nor a range is set.
   - Aggregate per file, cached by (path, size, mtime), so a scan only parses what changed. Run it in `spawn_blocking`.
   - Session queries use a cheap, indexed, session-filtered read.
   - Read `prompt-cache-usage` incrementally with an offset index. Reuse the pattern in `usage_cost/session_index.rs`.
   - Never wait on quota. Return the stored quota; the `provider_quota_updated` event refreshes it.
2. **`/updates`**
   - GET returns the saved status immediately.
   - Refresh in the background when the status is older than 6 h, honoring ETag / If-None-Match.
   - Use a short connect timeout.
   - Write the status only when it changed.
   - POST forces a refresh.
   - An incompatible manifest shows a calm, terse status, not an error screen.
3. **UI**
   - Settings → Usage renders the last view immediately (module-level cache, following the `lastViews` pattern). Updates renders the last status.
   - The popover shows `/provider-quota` windows right away (~1 ms).
   - Show only subtle loading states, no banners.

## Acceptance
Run an E2E on a synthetic set of 500+ transcripts totalling hundreds of MB, generated at test time.
- `/usage-monitor?since_hours=24` and `?session_id=` return in under 300 ms, and do not scale with the number of transcripts.
- The second all-time call is a cache hit, under 100 ms.
- Session results are filtered to that session.
- `/updates` GET does not wait on a delayed manifest server.
