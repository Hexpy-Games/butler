# Handoff: Claude Code → Codex (2026-09-29)

This covers what shipped, what is in flight, and what remains for **0.1.0**. After 0.1.0, Codex continues the work. PR and issue numbers refer to `Hexpy-Games/butler`.

## 0. Ground rules (still in force)

- **E2E first.** Non-E2E tests are allowed only in four categories: `race`, `security`, `pure-logic`, `format-pin`. Each must be tagged `// test-category: <cat>`. The `tools/source-check` ratchet (`source-check-tests.txt`) may only go down.
- **Code shape.** Files ≤500 lines and production functions ≤80 lines, enforced by source-check. OS-specific code lives only in `crates/butler-platform` (#260).
- **Performance is a hard requirement.** Test and review at owner scale: App DB 1.3–2.8 GB, BTCC ~7 GB, 2,440 transcripts (1.5 GB), metrics files over 300 MB. Every endpoint and background loop needs a budget (§4).
- **Real model calls in tests:** only `openai/gpt-6-luna` (effort max is fine). Never sol or astra. Stub or replay first.
- **Tests never touch `$HOME/.butler`.** Test fixtures were found in the owner's real ledger.
- **Terminology and copy.** UI copy is terse. In Korean, use "예약 작업" for schedules (never "자동화") and "버틀러" for Butler.
- **Telegram support is being removed.** It is no longer a target.

## 1. What shipped (main)

- **Bun → Rust port (#200).** Quality overhaul across the core, turn, models, runtime, memory, gateway, ledger, agent, platform, e2e and test-support crates, and an E2E harness with record/replay cassettes.
- **0.1.0 "Easy by default"** (tracking issue #236):
  - ask-first default (#262)
  - zero-config first run (#279, #257)
  - hide internals, advanced settings, starter suggestions (#245)
  - plain-language approvals (#277, #281)
  - keychain and cloud API keys (#290, #295)
  - data-folder token plus Host/Origin checks (#250, #275)
  - Settings → Security, with LAN access and a connection code (#249)
  - Git-only workspace picker (#280)
- **Stability fixes (recent):**
  - #302 TOOL-07-RESUME: fixes the ask-first approve/deny crash loop. Resume identity is checked, and replacement is capped at 1 per queue item.
  - #298: legacy subsession rows decode again, so session-view no longer returns 500.
  - #299: steward results are hidden from chat.
  - #305, #308: UI guards.
  - #307: restores the steward child contract and reconciles stuck `streaming` messages at startup.
- **Other merges:** #297 wallpaper, #309 repo hygiene plus the `lint:repo` guard, #313 DS hero split, #315 docs.
- **Distribution:**
  - #292: Linux DEB, RPM and Arch app packages with the agent bundled.
  - #300: standalone agent archives (darwin-arm64, linux-x64, linux-arm64), `deploy/install.sh` (curl | sh), the npm package `@hexpygames/butler` (`npx @hexpygames/butler install`), `install-smoke.yml`, and a draft → publish release flow.
  - #301: macOS Developer ID signing and notarization.
  - Secrets live in the GitHub environment `deploy`, restricted to `v*` tags. A tag ruleset lets only admins create `v*` tags.

## 2. In flight

| Item | Branch / PR | Needed for 0.1.0 |
|---|---|---|
| **SSD write hotfix.** Transcript projection is O(n²): `trailing` grows without bound and an 85 MB checkpoint row is re-encoded per record. The device id in the checkpoint identity forces full re-projection. Each `processed/` event triggers a full 616-chat sweep. Together this writes about 3.5 GB/min. | `claude/projection-quadratic-fix` (minimal hotfix first) | **YES (P0)** |
| Tests must never write to the real `$HOME/.butler` | `claude/tests-never-touch-home` | **YES** |
| CLI lifecycle: `install --from`, `update --apply`, `rollback`, `versions`, `uninstall`, `service install` (launchd/systemd) | #303 (fixing 3 re-review MUSTs) | **YES** |
| Usage-monitor, Updates and composer popover latency | `claude/usage-updates-latency` | YES |
| Remove Telegram support | `claude/remove-telegram` | YES (owner request) |
| Branch actions in project sessions (`POST /space/branches`) and the steward pill | #316 (review fixes requested) | YES |
| Windows preview | #304 (green; rebase onto #303) | No (preview) |
| Perf WS1, App storage | `claude/perf-app-storage` (draft) | Partial-index fixes are cheap wins |
| Perf WS2, turn hot path | `claude/perf-turn-hot-path` (draft) | No |
| Perf WS3, memory, including the **vector identity bug** | `claude/perf-memory` (draft) | No, but the vector bug is high priority right after |

The body of each draft PR lists what is done, partial and not started, with file:line next steps.

## 3. Remaining for 0.1.0 (in order)

- **P0-1: SSD hotfix.** Merge it, then build and upgrade the live service. The service is **stopped** by the owner's decision. After the upgrade, verify idle behaviour:
  - disk writes ≈ 0/min;
  - CPU < 5%;
  - footprint < 100 MB;
  - session-view < 300 ms.
- **P0-2: test-isolation guard.** Merge it. 1,386 fixture dirs were already deleted from the owner's machine. After the guard lands, check the remaining `project-ledger-fixture-*` and `r24-clean-ledger.*` dirs and clean them up.
- **P0-3: #303.** Merge it, then rebase #304 onto it.
- **P1: open PRs.** Usage/updates latency, #316, and the Telegram removal.
- **P1: #236 open items.**
  - #222 Skills progressive disclosure.
  - #234 Schedule UX for non-technical users.
  - #269 Unify schedule stores across App, CLI and chat.
- **Release.**
  1. The tag version must equal `crates/butler-agent-cli/Cargo.toml`.
  2. **The owner confirms before the tag is pushed.**
  3. The workflow signs and notarizes the Mac build, builds the Linux archives, publishes the release after all assets exist, then runs npm publish (`next` for prereleases).
  4. Verify on a clean Mac with `spctl`, `stapler`, and a first launch. If the app crashes at JIT, re-add `allow-unsigned-executable-memory`.
  5. Verify `curl … | sh` on Linux.
- **Docs.** README #251 (draft). Update the site install page for Linux packages and the one-liner.

## 4. After 0.1.0 (Codex backlog, highest impact first)

1. **BTCC storage.**
   - `btcc_model_round_acceptances` stores the full stateless input every round: 5.9 of 7.1 GB, O(n²) per turn. Keep only the latest continuation per turn, prune terminal turns, then VACUUM.
   - Startup `PRAGMA quick_check` takes about 23 s; gate it.
   - Tool-call rows are rewritten 4–5×.
   - Progress events have no retention.
2. **Memory vector identity bug.** New memories have had no vectors since the cutover. Needs a native re-embed and rebuild.
3. **Idle loops.**
   - Memory sync takes a lease at 1 Hz and runs a 27 MB query.
   - Catch-up re-registers 256 items every minute.
   - A 500 ms ingress poll runs over 3,014 `.done` tombstones plus an unindexed query.
   - The daily 325 MB metrics rewrite.
   - The developer log is rewritten (84 MB) on every turn.
4. **Read path.**
   - Add `turn_id<>''` partial-index predicates (250× measured).
   - `/work-status` is re-requested on every live event and reads all messages twice.
   - worker-activity is N+1, about 1,100 lane hops.
   - `list_sessions` scans transcripts for skill names.
   - session-view re-parses the 33 MB prompt log per poll and runs about 1,000 SQL statements.
   - The O(n²) progress dedupe.
   - GETs write checkpoints.
   - No ETag or gzip.
5. **Turn hot path.**
   - Whole-context tiktoken runs at least twice per round, on a tokio worker.
   - Re-serialization happens 3–5× per round.
   - The idle timeout misfires for non-streaming carriers.
   - No Anthropic `cache_control`.
   - A new MCP process or session per call.
6. **Perf CI tier.** Owner-scale seed, release build. Budgets:
   - idle CPU < 1%, idle footprint < 80 MB, 0 idle writes;
   - ready in < 1 s;
   - endpoint p95 of 50–150 ms;
   - n vs 4n growth < 1.5×;
   - no full scans on hot queries.
7. **Release profile.** Strip symbols, LTO, `codegen-units=1`. The binary is 288 MB, 45% of it lance/datafusion. Consider a separate memory-worker binary.
8. **Windows.** Task Scheduler, a `butler.exe` shim, a PowerShell installer, and the read-only command sandbox.
9. **Follow-ups:**
   - #311 steward presentation gaps;
   - #312 LAN bind error;
   - #314 approval risk defaults;
   - the `/space/branch-source` port;
   - events retention (pending the owner's decision; proposal: 30 days for replay-only events);
   - #226, #218, #272, #293;
   - T2 test cleanup (about 310 unit tests to replace with E2E).

## 5. Project-ledger spec updates needed

The `butler` ledger project was last updated 2026-08-31. Record these as spec or decision entries.

- **Auth model.**
  - The data-folder token is invisible locally.
  - LAN access is off by default. When on, the user gets a connection code they can view, copy and reissue.
  - An admin credential (`local-admin.json`, sent as `X-Butler-Admin`) is required for security settings.
  - Tunnel authentication is the user's responsibility. `allowedHosts` lives in `gateways/app.json`.
- **Install and distribution.**
  - The App bundles the agent. Agent-only installs use the CLI (`install.sh`, `npx`, and later PowerShell).
  - Shared layout: `AGENT_HOME/<ver>-<sha8>` with `current` and `previous` symlinks, and the launcher at `~/.local/bin/butler`. See `docs/install-layout.md` and `docs/install-lifecycle.md`.
  - `butler stop` stops the agent until the next login or start. `service uninstall` unregisters it.
- **Keychain.** The file store stays the default until a signed build ships.
- **Platforms.** macOS arm64 is the primary target. Linux x64 and arm64 are supported. Windows is a preview.
- **Steward results** are model input only and are never shown as chat bubbles. The card and pill come from `steward_children`.
- **Access.** Ask-first is the default, and approve/deny resumes the turn.
- **Telegram** support is removed.
- **Performance budgets** from §4.6 are part of the spec.
- **Release process.** The `deploy` environment and the tag ruleset. Releases stay drafts until all assets exist, then publish. npm uses `latest` for releases and `next` for prereleases.

## 6. Pointers

- **Draft PR bodies** hold per-item status with file:line.
- **Audit tables** are in the Claude session transcript; ask the owner for an export if needed. §4 summarizes them.
- **Live machine.**
  - The service is installed at `~/Applications/ButlerAgent/0.0.21-rust-1d7c7ef6` and is currently stopped. The previous build is `14df7083`.
  - Backups are in `~/.butler/backups/` (`upgrade-1d7c7ef6-*`, `pre-legacy-drop-*`).
  - On 2026-09-29 the legacy App-DB `btcc_*` tables (all except `btcc_turns`) were dropped and the database was VACUUMed: 2.8 GB → 1.25 GB.
  - The dev app runs from the `main-live` worktree on Vite `127.0.0.1:5173`, with `BUTLER_APP_DEV_ORIGIN` set.
