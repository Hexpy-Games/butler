# BTCC R3 memory and process lifetime validation — 2026-08-01

## Result

The memory incident is closed for the tested macOS product path.

- The production Butler services idle at about 411 MiB total physical footprint.
- The embedding service idles at 12 MiB and does not load BGE-M3 until the first embedding request.
- A real Electron, real-provider, five-turn scenario completed through four launches with a 3,015,163,904-byte peak owned RSS and zero owned RSS after cleanup.
- Reproducible packaging copies were removed from the run roots while evidence, databases, logs, outputs, and screenshots were retained.
- No model-facing BTCC state, tool restriction, answer validator, or review requirement was added.

The real-model evidence is stored at:

`~/.butler-e2e/btcc-r3-memory-lifetime-20260801/model-03/evidence.json`

## Measured causes

The reported 30 GiB growth had several independent lifetime causes.

1. Benchmark process output, CDP waits, turn waits, and cleanup did not all have hard bounds.
2. Electron launch children could survive interruption or a failed cleanup path.
3. Run-local Agent installations and credential copies accumulated across attempts.
4. The live-event request used Bun's default idle timeout while the SSE heartbeat arrived later. The UI then reconnected every second and refreshed the full session projection on each transport error.
5. The embedding server loaded BGE-M3 during startup even when memory search was never requested.
6. Isolated Electron runs shared the production embedding socket and health port.
7. App-managed archive handling originally retained archive-scale buffers.
8. Bun 1.3.11's Node zlib stream could stop after compressed EOF under an Electron parent. The exact Electron reproduction timed out in 3 of 10 attempts.
9. Every Electron restart repeated archive hashing, runtime-directory hashing, archive decompression, and roughly 12,000 installed-file hashes before the startup deadline began.

## Product changes

### Embedding and live events

- BGE-M3 is loaded on the first embedding request and reused afterward.
- The health endpoint reports whether the model is loaded.
- App-managed instances use a private per-user socket and an ephemeral health port.
- SSE requests disable Bun's request idle timeout.
- UI reconnect delay backs off to 30 seconds and transport errors no longer trigger full-view refresh churn.
- Live cursors advance only after an event is applied successfully.

### App-managed runtime

- POSIX archive input is read in fixed 64 KiB chunks and decompressed with `DecompressionStream`; the whole archive is never retained.
- Extract and verify workers have a 60-second owner-side deadline. A timeout preserves the selected runtime and is not treated as proof of corruption.
- Successful install and readiness already produce `runtime.json`; normal restarts now reuse that activation receipt and verify only the required launch files.
- Full verification remains on first install, update, receipt mismatch, required-file damage, explicit repair, and recovery after an unexpected exit.
- Explicit repair and unexpected exit invalidate the receipt and cached command before resolving the runtime again.

This fast path trusts the existing unsigned, user-owned local runtime boundary. It does not claim protection from an adversarial process running as the same user. That stronger boundary requires a signed/read-only runtime or operating-system integrity enforcement, not another launch-time state machine.

## Archived Electron-parent archive-stream regression guard

The archive result above remains a release and Bun A/B eligibility guard. The
reproduction runs the real POSIX archive worker as a child of Electron's launch
process, with the same compressed Agent archive and extraction destination for
each runtime. A run is successful only when the worker emits its completed JSON
record, the launcher is present in the extracted tree, and the child exits
cleanly; compressed-EOF timeout, truncated output, or a non-zero worker exit is
a regression. Repeat the guard ten times per runtime. The historical Bun
1.3.11 reproduction completed 7/10 attempts, while the streaming worker path
completed 10/10; that archived 1.3.11 result is diagnostic evidence and is not
silently treated as a candidate win. Any new candidate must reproduce the
10/10 result before it can be eligible for the RMF-SC10 runtime decision.

The guard is intentionally independent of the physical-memory comparison:
cache-mismatched or otherwise incomparable A/B samples remain descriptive,
and a lower memory snapshot never waives an archive-stream failure.

### Benchmark harness

- Captured stdout and stderr are bounded.
- CDP, step, provider, post-turn, and cleanup operations have deadlines.
- Owned process trees are sampled without blocking the event loop and must reach zero after cleanup.
- Signals run the same full cleanup path.
- A cleanup incident stops the benchmark instead of becoming a product score.
- Exactly two run-local credential copies are removed after use; the source credentials and all other files are preserved.
- Reproducible R3 runtime-version trees are pruned only after observation evidence is persisted.

## Validation evidence

### Archive worker

The real 213,670,022-byte Agent archive produced:

- extraction: 12,220 files, 6.90 seconds, 105,136,128-byte maximum RSS;
- verification: 12,217 files, 5.01 seconds, 93,405,184-byte maximum RSS;
- missing input failure: 0.03 seconds;
- truncated gzip failure: 0.30 seconds;
- Electron-parent repeat: old zlib 7/10 success, new worker 10/10 success.

### Electron smoke

`smoke-04/evidence.json`:

- `ok: true`;
- first install/launch: 16.2 seconds;
- second restart: 5.3 seconds;
- peak owned RSS: 813,432,832 bytes;
- final owned RSS: 0;
- owned PIDs after cleanup: none;
- run-local credential copies after cleanup: none.

### Real-model lifecycle

`model-03/evidence.json` used `openai/gpt-5.6-sol`, low reasoning, the real Electron renderer, the app gateway, the native BTCC runtime, and the real provider.

- direct translation: delivered without Work;
- read-only file comparison: completed Work with accepted plan and result reviews;
- artifact creation: wrote and reread `artifact/report.md`;
- open Work: wrote a draft, preserved `status: open`, and restarted without forcing an intermediate result review;
- continuation: reused the same Work ID, edited and reread the file, then completed it;
- launches: 4;
- resource samples: 36;
- observed owned processes: 68;
- peak owned RSS: 3,015,163,904 bytes;
- final owned RSS: 0;
- owned PIDs after cleanup: none;
- credential cleanup: complete.

The embedding model was loaded only after real embedding requests. It used roughly 0.9 GiB in one process and did not accumulate across restarts.

### Operating Butler

After applying the fixes to `main` and restarting the native services:

- embedding service physical footprint: 12 MiB;
- all six Butler Bun service footprints combined: about 411 MiB;
- embedding health: `model_loaded: false` while idle;
- SSE: HTTP 200 remained connected for 22 seconds and received 211 bytes;
- gateway CPU after the SSE check: 0.5%.

## Validation commands and review

- R3 full `bun run check`: passed.
- Focused App runtime and supervisor tests: 46 passed.
- Release packaging tests: 23 passed.
- Lint, typecheck, and diff checks: passed.
- Independent product review: no critical findings after receipt invalidation, cache eviction, and worker deadline fixes.

The `main` aggregate check still reports two pre-existing BTCC plan-graph files above the 350-line design limit. Their line counts are identical before and after this work; focused validation, lint, and typecheck pass.

## Commits

R3 product branch:

- `111db0f2` — bound product memory lifetimes;
- `a7fe3bbe` — finish real archive streams;
- `8a6d0b33` — isolate the foreground embedding endpoint;
- `ba2ea664` — make App runtime restarts bounded.

Benchmark harness branch:

- `03418a8f` — bound benchmark process lifetimes;
- `5d861ba6` — remove run-local credential copies;
- `f6004032` — keep open-Work result review optional.

Production `main` equivalents:

- `b579e6d0`, `af5d68bb`, `950ffb3c`, `0c871121`.
