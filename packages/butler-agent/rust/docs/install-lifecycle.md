# Agent install lifecycle

What the Rust CLI does to an Agent home, and the contract other installers
(`install.sh`, the npm wrapper, the desktop App) can rely on. The layout itself
(`AGENT_HOME`, version directories, `current`, `previous`, the launcher) is
specified in [install-layout.md](install-layout.md); this page adds the
commands that change it.

## Commands

All commands take `--json` (one envelope: `ok`, `command`, `data`, `error`,
`privacy`) and `--data PATH`. Failures print `code: message` (or the JSON
`error`) and exit non-zero; a missing confirmation exits 2.

| Command | Effect |
|---|---|
| `butler install --from ARCHIVE\|URL [--sha256 HEX] [--no-restart]` | Verify, extract into `AGENT_HOME/<version>-<sha8>`, switch `current`, write the launchers, prune, restart a running service on it. |
| `butler update [--check\|--dry-run\|--apply --yes] [--no-restart]` | Same as `install` for the artifact of the update manifest that names this host's platform. `--check` and `--dry-run` change nothing. |
| `butler versions` (also `update --list`) | Installed versions; `*` marks the active one, `previous` the rollback target. |
| `butler rollback [--to VERSION\|DIR] [--yes] [--dry-run] [--no-restart]` | Switch `current` to `previous` (or the named version) and restart a running service on it. Asks on a terminal; elsewhere needs `--yes`. |
| `butler uninstall [--keep-data\|--purge-data] --yes [--dry-run]` | Stop the service, remove login-start, launchers and the Agent home. Data stays unless `--purge-data`. |
| `butler service install\|uninstall\|status [--files-only]` | Login-time start (see below). |

### `install --from` (the contract for installers)

`--from` is a local path, a `file://` URL, or an `https` URL (`http` only to
this machine). A downloaded archive must come with `--sha256` (nothing else
vouches for it); it goes to a scratch directory outside DATA that is deleted
afterwards, is refused above 2 GiB (`install_archive_too_large`;
`BUTLER_INSTALL_MAX_BYTES` lowers the cap), and a redirect never leaves https.
For a local file `--sha256` is optional, because the archive's manifest digests
are checked after extraction either way. Order of work:

1. take the Agent home lock (`.install.lock`); a second install, update,
   rollback or uninstall gets `install_busy` instead of interleaving;
2. check the archive's SHA-256 (when given) **before** anything is extracted;
3. extract into `AGENT_HOME/.staging-*` (only regular files, directories and
   relative links that stay inside the tree; no `..`, absolute paths, hard
   links, devices, duplicate paths or writes through links), then check the
   manifest (`butler.native-agent-install.v1`, this platform) and the digests
   it records for `butler-agent` and `resources/`, and the `butler` link;
4. rename into `<version>-<sha8>` (a verified existing directory is reused;
   the active and previous versions are never modified);
5. point `previous` at the old `current`, then `current` at the new directory;
6. write `~/.local/bin/butler` (and repoint `DATA/bin/butler`, if it is ours);
7. prune to the three most recently installed versions, always keeping the
   active, the previous and any version a running service executes from;
8. restart the service on the new version if one is running (not with
   `--no-restart`).

`data` of the JSON result: `dir`, `version`, `path`, `alreadyInstalled`,
`previous`, `replaced`, `changed`, `pruned`, `agentHome`, `launchers`
(`command.path`, `command.state`, `command.onPath`), `service`
(`wasRunning`, `restarted`, `pid`). Exit codes: 0, 1 (failure, with an
`install_*` or `update_*` code), 2 (bad arguments or confirmation missing).

**Stable contract for other installers.** `install.sh` and the npm wrapper
should not re-implement steps 1-8: after downloading and checking the archive
they extract it to a temporary directory (or use `tar` on just
`butler-agent`, `resources/` and the manifest) and run

```sh
./butler-agent install --from <local archive> --sha256 <hex> [--no-restart] --json
```

`--from <local archive>`, `--sha256`, `--no-restart` and `--json`, the result
fields above and the exit codes are the interface and do not change without a
new major of this page. A fresh install has no service to restart, so the call
is safe on a first install; on an upgrade the running service is restarted
unless `--no-restart` is given.

### Restarting on the new version

`update`, `install` and `rollback` run the **new** binary's `restart --json`
as a child process, so the replacement service is the new version. That is the
existing stop-intent restart: the old instance gets a `restart` intent, exits
0, and the controller (this CLI) starts the replacement. A service the App
supervises is instead restarted by the App (`respawn_by: app`), which resolves
its Agent again at that moment (see "App"), and one a login job supervises is
restarted through the job (see "Login-time start"). A service that was not
running is left stopped.

The result says what runs afterwards, not what was asked for:
`service.executable` is the process now serving, `service.onNewVersion` says
whether that is the version just activated, and the human line says "not on the
new version" when the App chose its bundled Agent instead.

If the restart fails, what was running is put back: the previously active
version when there was one, otherwise the installation the service ran from
(and the version just installed stops being active, with no launcher pointing
at it). The command then fails with `update_restart_failed` (or
`install_restart_failed`, `rollback_restart_failed`) and says whether the
previous service is running again. Launchers are only rewritten after a
successful restart.

### Manifest policies

Update manifests carry `activation_policy: "butler-managed"` and
`rollback_policy: "supported"`. Manifests published before this change
(`user-installs-standalone-archive`, `not-managed-by-butler`) describe the same
archive and are still accepted. `butler update` selects the artifact whose
`platform` equals this host's (`darwin-arm64`, `linux-x64`, `linux-arm64`); an
artifact for another platform, or one with no platform, is never selected
(`update_manifest_agent_platform_missing`).

## The `butler` launchers: one canonical, one pointer

- **Canonical:** `~/.local/bin/butler` (`BUTLER_BIN_DIR` overrides the
  directory). It runs `AGENT_HOME/current/butler-agent` with
  `--installation-root` / `--resource-root` set to `AGENT_HOME/current`, so
  switching versions never rewrites it. Written by `install`, `update` and
  `rollback`; rewritten if it carries the marker `# butler-native-launcher v1`
  on line 2, left alone otherwise (`launchers.command.state: "kept-foreign"`).
  A stale pre-native (Bun) launcher there is kept as `butler.previous`.
- **Pointer:** `DATA/bin/butler` (`host/service/cli_launcher.rs`) is the older
  location. It is the same script plus a default `BUTLER_DATA`, and it is only
  ever *repointed*, never created. `install`, `update` and `rollback` point it
  at `AGENT_HOME/current`; every service start points it at the installation
  that service runs, which is what the App chose when it launches the newer of
  its bundled Agent and `current`. So it always runs the Agent that serves that
  data folder. Only a file with the marker or the exact stale Bun launcher
  (a program that runs `$BUTLER_HOME/bin/butler.js`) is rewritten, the first
  stale one is kept as `butler.previous`, an existing `butler.previous` is never
  overwritten, and any other file is left alone.
- **Migration:** nothing to do for an existing owner. A `DATA/bin/butler` that
  pointed at the App bundle is repointed to `AGENT_HOME/current` the first time
  a CLI install is activated (it is never created, so a data folder that never
  had one still has none). `uninstall` removes a launcher only when the program
  it runs lies inside the Agent home being removed (a path comparison), so a
  launcher for another home or an App bundle stays.

## Login-time start

`butler service install` writes the definition and asks the manager to load it
(`--files-only` only writes or removes the file). It needs an installed Agent
(`butler install` first): the job runs `AGENT_HOME/current/butler-agent`, never
an App bundle or a legacy directory, and it is refused while the Butler App
supervises the service. `BUTLER_APP_SERVER_HOST`, `BUTLER_APP_SERVER_PORT` and
`BUTLER_SECRET_STORE` are recorded from the installing environment; the job's
`PATH` is fixed (`/usr/local/bin:/usr/bin:/bin` for systemd, plus
`/opt/homebrew/bin` and the sbin directories for launchd), not the shell's.
Values with line breaks are refused, and `%` and `$` are escaped in the unit.

| Host | Definition | Label |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.hexpy.butler.agent.plist` | `com.hexpy.butler.agent` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/butler-agent.service` | `butler-agent.service` |
| Windows | not supported yet (the platform API reports `Unsupported`) | |

The definition runs
`AGENT_HOME/current/butler-agent ... service run --data DATA --detached --if-absent`.
Crash-only restart (`KeepAlive.SuccessfulExit=false`, `Restart=on-failure`)
relies on the stop-intent contract: `butler stop` and SIGTERM make the service
exit 0, which the manager does not restart. `--if-absent` makes `service run`
exit 0 when an instance already owns DATA.

**A supervised instance stays supervised.** A signal sent straight to the
process (the SIGKILL `butler stop` escalates to after its grace period) looks
like a crash to the manager. So when the manager runs the instance
(`service_registration::job()` is loaded and its pid is the record's):

- a stop that outlives its grace period goes through the manager (`launchctl
  bootout`, `systemctl --user stop`) instead of a kill, and the systemd unit
  also carries `RestartPreventExitStatus=SIGKILL`;
- `restart` stops the instance politely (SIGTERM, clean exit) and starts the
  replacement through the manager (`launchctl kickstart`, `systemctl --user
  start`), so it is supervised again;
- a restart the service asks for itself (the restart handoff) is one request to
  the manager (`systemctl --user restart`, or unload, wait, load on launchd),
  because systemd stops everything in the unit's cgroup with the old process,
  including a helper and a replacement started from inside it;
- `start` with the job loaded but idle starts it through the manager.

When no job is loaded (nothing registered, a sandbox `HOME`, no manager) none
of this applies and the CLI starts and stops the service itself.

The labels differ from the legacy `com.hexpy.butler` / `butler.service` that the
App's one-time migration removes (`app-legacy-service-migration.mjs`), so that
migration can never delete a registration made by the CLI. There is no
migration of the legacy labels in the CLI; the App owns it. `uninstall` removes
a registration only when its program lies inside the Agent home (a path-component
comparison, so `.../agent` does not own `.../agent-home`).

Tests never let the real manager load a definition from a sandbox `HOME`: E2E
registers with `--files-only` and checks the generated file. INS-14 runs a real
`systemd --user` job on Linux CI (skipped where the runner has no user manager).

## Uninstall

Only what the installer put in place is removed: version directories,
`current`/`previous`, staging leftovers and the lock inside the Agent home (a
foreign file there stays, and keeps the directory); the launchers that carry the
marker and run the Agent home; a registration that runs a program from the Agent
home. Directories named `<version>-rust-<sha8>` by an earlier installer are
listed as versions (verified by their own manifest) and can be rolled back to,
but are never pruned or removed. Deletion never follows symlinks, and read-only
(archive-extracted) trees are made writable first.

`--purge-data` also deletes the data folder, but refuses (`unsafe_path`) a
folder that is a symbolic link *as named* (before its links are resolved), one
that does not look like a Butler data folder (`butler.config.json`, `state`,
`agent-runtime` or `config`), the home directory or one of its parents, a system
folder, and anything that contains or lies in the Agent home. It holds the DATA
admission lock (the one `start`, `stop` and `restart` take) while it deletes, so
a start cannot race the deletion. The App bundle is never touched.

## App

`bundled-native-agent.mjs` (`resolveNativeAgentInstallation`, packaged App)
compares the bundled Agent's version with `AGENT_HOME/current`'s manifest
(same rules and environment as the CLI, `BUTLER_AGENT_HOME`) and launches the
newer; equal versions keep the bundled one. It re-resolves at every launch, so
a restart the App carries out after `butler update` starts the new version. The
App-managed launchd bridge (legacy) still uses the bundled Agent.

## `butler version` in App layouts

`payload_provenance` looked for `native-agent-manifest.json` in the
installation root. An App does not put it there: the installation root is the
package directory (`/opt/butler/Butler-linux-x64`) or the app bundle
(`Butler.app`), while the manifest sits with the payload, in
`resources/bundled-agent/` or `Contents/Resources/bundled-agent/`. The lookup
found nothing, so `version` said "unavailable" and `doctor` warned. The payload
root is now the parent of the resource root when that lies inside the
installation root (a standalone installation: the root itself), for the
manifest, the binary and resource paths, and the launcher check. `app_version`
already read it that way. INS-03 runs both App shapes.

## Platform domain API (`butler-platform`)

- `user_dirs::agent_home()`, `command_dir()`: per-OS defaults and the
  `BUTLER_AGENT_HOME` / `BUTLER_BIN_DIR` overrides.
- `install_link::{point, read, remove}`: atomic `current`/`previous` (relative
  symlink; a pointer file on Windows).
- `command_launcher::{render, ownership, write, is_current, keep_previous,
  remove_if_ours, default_path, file_name, program}`: launcher text, marker and safe
  replacement (`sh` script; `.cmd` on Windows).
- `service_registration::{install, uninstall, status, is_owned_by, render,
  definition_path, manager, job, start, stop, restart}` with
  `Activation::{Load, FilesOnly}`: launchd, systemd `--user`; Task Scheduler
  reports `Error::Unsupported`. `job()` says whether the manager has the job
  loaded and which pid it runs; `start`/`stop`/`restart` are requests to the
  manager.
- `secure_fs::remove_tree`: removal without following links, after making the
  tree writable.
