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

`--from` is a local path, a `file://` URL, or an `http(s)` URL. A downloaded
archive must come with `--sha256` (nothing else vouches for it); for a local
file `--sha256` is optional, because the archive's manifest digests are checked
after extraction either way. Order of work:

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

`install.sh` may call the extracted binary as
`./butler-agent install --from <archive> --sha256 <hex>` instead of
re-implementing steps 1-7; the shell installer in this repository implements
the same layout itself and stays compatible (same directory names, pointer
switching and launcher text).

### Restarting on the new version

`update`, `install` and `rollback` run the **new** binary's `restart --json`
as a child process, so the replacement service is the new version. That is the
existing stop-intent restart: the old instance gets a `restart` intent, exits
0, and the controller (this CLI) starts the replacement; a service the App
supervises is instead restarted by the App (`respawn_by: app`), which resolves
its Agent again at that moment (see "App"). A service that was not running is
left stopped. If the restart fails after an update, the previous version is
made active again and started, and the command fails with
`update_restart_failed`.

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
  ever *repointed*, never created: by `install`/`update`/`rollback`, and at
  every service start. It runs `AGENT_HOME/current` when a CLI installation is
  active and otherwise the installation of the service that started (the App's
  bundled Agent for an App-only user). Either way there is one Agent behind
  every `butler` on the path. As before, only a file with the marker or the
  stale Bun launcher is rewritten (the first stale one is kept as
  `butler.previous`, an existing `butler.previous` is never overwritten), and
  any other file is left alone.
- **Migration:** nothing to do for an existing owner. A `DATA/bin/butler` that
  pointed at the App bundle is repointed to `AGENT_HOME/current` the first time
  a CLI install is activated (it is never created, so a data folder that never
  had one still has none). `uninstall` removes `DATA/bin/butler` when it runs
  the Agent home, since it would dangle; one that runs an App bundle stays.

## Login-time start

`butler service install` writes the definition and asks the manager to load it
(`--files-only` only writes or removes the file):

| Host | Definition | Label |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.hexpy.butler.agent.plist` | `com.hexpy.butler.agent` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/butler-agent.service` | `butler-agent.service` |
| Windows | not supported yet (the platform API reports `Unsupported`) | |

The definition runs
`AGENT_HOME/current/butler-agent ... service run --data DATA --detached --if-absent`
with `BUTLER_DATA` and the installing shell's `PATH`. Crash-only restart
(`KeepAlive.SuccessfulExit=false`, `Restart=on-failure`) relies on the
stop-intent contract: `butler stop` and SIGTERM make the service exit 0, which
the manager does not restart. `--if-absent` makes `service run` exit 0 when an
instance already owns DATA, so a manager start at login never crash-loops
against a CLI-started service.

The labels differ from the legacy `com.hexpy.butler` / `butler.service` that the
App's one-time migration removes (`app-legacy-service-migration.mjs`), so that
migration can never delete a registration made by the CLI. There is no
migration of the legacy labels in the CLI; the App owns it. `uninstall` removes
a registration only when its program lies inside the Agent home.

Tests never let the real manager load a definition: the manager is the user's,
not the sandbox `HOME`'s. E2E registers with `--files-only` and checks the
generated file.

## Uninstall

Only what the installer put in place is removed: version directories,
`current`/`previous`, staging leftovers and the lock inside the Agent home (a
foreign file there stays, and keeps the directory); the launchers that carry the
marker; a registration that runs a program from the Agent home. Deletion never
follows symlinks, and read-only (archive-extracted) trees are made writable
first. `--purge-data` also deletes the data folder, but refuses (`unsafe_path`)
a symlink, the home directory or one of its parents, a system folder, and
anything that contains or lies in the Agent home. It holds the DATA admission
lock (the one `start`, `stop` and `restart` take) while it deletes, so a start
cannot race the deletion. The App bundle is never touched.

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
  remove_if_ours, default_path, file_name}`: launcher text, marker and safe
  replacement (`sh` script; `.cmd` on Windows).
- `service_registration::{install, uninstall, status, is_owned_by, render,
  definition_path, manager}` with `Activation::{Load, FilesOnly}`: launchd,
  systemd `--user`; Task Scheduler reports `Error::Unsupported`.
- `secure_fs::remove_tree`: removal without following links, after making the
  tree writable.
