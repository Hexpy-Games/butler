# 03. CLI lifecycle (#303, P0)

**Start from:** #303 (`claude/cli-install-lifecycle`). The PR body has a checklist of the re-review items. #300 is already on main.

## What #303 adds
Commands, each with a `--json` form:
- `butler install --from ARCHIVE|URL [--sha256] [--no-restart]`
- `update --apply --yes`
- `rollback [--to V]`
- `versions`
- `uninstall [--keep-data|--purge-data] --yes`
- `service install|uninstall|status [--files-only]`

Layout:
- `AGENT_HOME/<ver>-<sha8>` with `current` and `previous` symlinks.
- `~/.local/bin/butler` is the canonical launcher.
- `DATA/bin/butler` points to the installation that actually runs.

The login-start labels are `com.hexpy.butler.agent` and `butler-agent.service`. They are deliberately not the App's legacy labels, which the App's migration deletes.

Contract docs: `packages/butler-agent/rust/docs/install-layout.md` (from #300) and `docs/install-lifecycle.md` (in #303).

## Remaining MUSTs from the re-review (verify each in the PR checklist)
1. **Start routing.** `butler start` routes to the login job only when the registered definition's `--data` equals this DATA and its program is inside the Agent home (`lifecycle.rs:~176`).
   - launchd and systemd `--user` are per user, not per HOME. E2E must never touch a real manager unless an explicit env var opts in.
   - `start` uses `service_registration::start()` when the job is registered and ours.
2. **Linux self-restart.** A restart requested from inside the service must not spawn a helper that systemd kills along with the cgroup. Use a single `systemctl --user restart`, or a `systemd-run --user --scope` helper. At startup, finalize any dead `spawned` handoffs.
3. **systemd escaping.** In `WorkingDirectory=`, escape only `%` as `%%` and quote it; `\xNN` is not decoded there (`systemd.rs:96-109`). Leave `$` literal in `Environment=`. The INS-14 data path must contain a space and non-ASCII characters.

## Remaining SHOULDs
4. **macOS forced stop.** If `launchctl print` fails, never fall back to SIGKILL for a possibly managed job.
5. **launchd reload.** Unload, wait, reload. If the old PID is still alive, fail instead of reloading. Retry the reload once. Guard against PID reuse by also comparing the process start time.
6. **Stop timeouts.** Set `TimeoutStopSec` in the unit and `ExitTimeOut` in the plist, consistent with the #244 grace period.
7. **Launcher target after update.** Point `DATA/bin/butler` only at the installation that actually runs (`context.rs:~113`).
8. **Downloads.**
   - Create the scratch dir with mode 0700.
   - Clean up the staged archive when an update fails.
   - Replace the whole-request 60 s HTTP timeout with a stall timeout for artifacts.
   - INS-12 covers a response with no Content-Length, and a refused cross-origin redirect to loopback.
9. **Old launcher detection.** Match the exact shape of the old Bun launcher and document it in `install-lifecycle.md`. Then align `deploy/install.sh`, which today requires both `butler.js` and `BUTLER_HOME`.

Also add an E2E for the App's choice between its bundled agent and a newer `AGENT_HOME/current`.

## Acceptance
- INS-02 through INS-14 pass. INS-14 runs a real `systemd --user` job on the Linux CI runner and covers self-restart, forced stop, and a data path with a space and Korean characters.
- The full CI suite, including the install-smoke matrix, is green.
- The owner's legacy directories (`0.0.21-rust-<sha8>`) are listed and can be rolled back to, but are never pruned (INS-13).
