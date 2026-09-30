# 0.1.0: remaining work (ordered)

This file is the status source. `HANDOFF.md` at the repo root covers what has already shipped.

| # | Plan | Priority | Start from |
|---|---|---|---|
| [ ] | [01 SSD write hotfix: transcript projection](01-projection-hotfix.md) | **P0** | `claude/projection-quadratic-fix` (draft PR) |
| [x] | [02 Tests never touch `$HOME/.butler`](02-test-isolation-guard.md) | **P0** | `claude/tests-never-touch-home` (draft PR) |
| [ ] | [03 CLI lifecycle (#303)](03-cli-lifecycle.md) | **P0** | #303 |
| [x] | [04 Usage and updates latency](04-usage-updates-latency.md) | P1 | `claude/usage-updates-latency` (draft PR) |
| [ ] | [05 Remove Telegram](05-remove-telegram.md) | P1 | `claude/remove-telegram` (draft PR) |
| [ ] | [06 Branch actions and steward pill (#316)](06-branch-actions.md) | P1 | #316 |
| [ ] | [07 Cheap read-path wins](07-read-path-quick-wins.md) | P1 | `origin/main` (reuse parts of `claude/perf-app-storage`) |
| [x] | [08 Skills progressive disclosure (#222)](08-skills-disclosure.md) | P1 | `origin/main` |
| [x] | [09 Schedule store unification (#269)](09-schedule-store.md) | P1, before 10 | `origin/main` |
| [x] | [10 Schedule UX (#234)](10-schedule-ux.md) | P1 | after 09 |
| [x] | [11 Windows preview merge (#304)](11-windows-preview.md) | P2 (can ship after 0.1.0) | #304, after 03 |
| [ ] | [12 Release v0.1.0](12-release.md) | final | after 01–10 |
| [ ] | [13 Live upgrade, cleanup, project-ledger sync](13-owner-machine.md) | **OWNER-MACHINE** | after 01, and again after 12 |

Dependencies:
- 03 lands before 11.
- 09 lands before 10.
- 01, 02 and 03 land before 12.
- Don't cut any release tag until #300 and 03 are both on main. The current updater on main selects only darwin artifacts.
