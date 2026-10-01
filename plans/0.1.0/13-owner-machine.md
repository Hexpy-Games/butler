# 13. Owner machine: live upgrade, cleanup, project-ledger sync (OWNER-MACHINE)

Do this only when the owner asks. Never kill a process by name pattern. The owner's service is currently **stopped** because of the SSD write bug.

## Live upgrade (after plan 01, and again after each release)
1. Build the standalone archive from main. Use the release pipeline scripts (`release:agent:gate`, `release:agent:package`, `release:agent:smoke`) in a fresh worktree with the ORT static env.
2. Install into a new directory: `~/Applications/ButlerAgent/0.0.21-rust-<first 8 of binarySha256>/`. Verify the archive sha first.
3. Back up the App DB (`~/.butler/app-server/butler-client.sqlite`) and the BTCC DB (`~/.butler/agent-runtime/btcc.sqlite`). Use `sqlite3 .backup` or a copy taken while the service is stopped.
4. `"$NEW/butler-agent" stop --data ~/.butler` (a graceful stop), then `BUTLER_APP_DEV_ORIGIN=http://127.0.0.1:5173 "$NEW/butler-agent" start --data ~/.butler`.
5. Verify:
   - `/health` returns 200.
   - Session-view for a project session returns 200 in under 300 ms.
   - Idle for 10 minutes: CPU under 5%, footprint under 100 MB, disk writes close to 0, and the App DB WAL under 64 MB. Measure with `ps`, `footprint`, and `proc_pid_rusage` deltas.
6. The owner's desktop app runs from the `main-live` worktree, on Vite at 5173. Fast-forward it with `git pull --ff-only`. Vite hot-reloads; if it doesn't, restart `bun run app:client:dev`.

## Cleanup (after plan 02 merges)
- Remove leftover test fixtures under `~/.butler/project-ledger/projects/` whose names match `project-ledger-fixture-*`, `project-ledger-repair-check.*`, `r24-clean-ledger.*` or `butler-ledger-check-*`. List them and show the owner before deleting.
- Keep `~/.butler/backups/pre-legacy-drop-*` until the upgraded service has run cleanly for a day. Then drop it, along with the older upgrade backups.

## Project-ledger sync
The `butler` project in the ledger was last updated 2026-08-31. Publish with the Project Ledger CLI (`packages/project-ledger/bin/project-ledger plan|record create|update --project . --from <file>`, `BUTLER_DATA=~/.butler`), then run `render dashboard|handoff|roadmap --write` and `check`. Never hand-edit ledger files. The 2026-09-29 docs are already published (see plans/README.md).
