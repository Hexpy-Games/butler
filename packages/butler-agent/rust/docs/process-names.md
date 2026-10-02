# Agent process roles

Only OS processes get labels; tasks inside the service do not imply a separate
process. English role labels are lowercase. The main service keeps
`butler-agent`.

| Process / caller | Launch | macOS `proc_name` | Linux `comm` | Linux `argv[0]` | Windows image filename |
| --- | --- | --- | --- | --- | --- |
| Layout preparation: installer/packager | `--prepare-process-links` before aliases exist | `butler-agent` | `butler-agent` | unchanged | `butler-agent.exe` |
| Main service: CLI, login manager, Electron | `service run --data D --detached`, or desktop stdio entrypoint with installation/resource roots | `butler-agent` | `butler-agent` | unchanged | `butler-agent.exe` |
| Embedding owner | `--private-embedding-worker`, `BUTLER_DATA=D`, piped stdin/stdout, kill on drop | `butler-agent (memory)` | `butler-memory` | `butler-agent (memory)` | `butler-agent (memory).exe` |
| MCP restart tool | `restart --data D --json --requested-by mcp`, installation/resource roots | `butler-agent (restart)` | `butler-restart` | `butler-agent (restart)` | `butler-agent (restart).exe` |
| Service restart handoff | `service restart-handoff --data D --quiet`, roots, identity via stdin, detached | `butler-agent (restart)` | `butler-restart` | `butler-agent (restart)` | `butler-agent (restart).exe` |
| Installer/update lifecycle helper | selected installation's `start`/`restart`/`stop --json --data D`, roots | `butler-agent (update)` | `butler-update` | `butler-agent (update)` | `butler-agent (update).exe` |

Scheduler, memory maintenance, BTCC workers, App HTTP gateway and MCP server are
in-process tasks. There is no scheduler process of the Agent binary. Electron's
macOS menu bar helper is a separate Swift executable (`Butler Menu Bar Helper`),
not another invocation of the Agent. External tools, shells, browser binaries
and provider processes retain their own names.

## OS monitor behavior

- macOS: full-name hardlinks preserve signed binary bytes. Symlinks resolve to
  the original name in `proc_name`; hardlinks expose the alias. `proc_name`
  accepts up to 32 characters, so all three full names fit. `top` and
  `ps -o ucomm` truncate to 16 characters; this is acceptable. `ps -ww -p PID
  -o args=` shows the full role in argv. The E2E checks `proc_name` and argv for
  all three workers; a codesign check verifies each hardlink.
- Linux: aliases and leader `comm` use `butler-memory`, `butler-restart` and
  `butler-update`, each within the 15-byte kernel limit. `PR_SET_NAME` sets
  `comm` on the main thread. `ps`/`top` using comm show the short role;
  `ps -ww -p PID -o args=` shows the full `butler-agent (role)` argv[0]. The
  E2E checks `/proc/PID/comm` and argv on Linux CI.
- Windows: hardlink filenames are `butler-agent (role).exe`; spawning through
  them supplies the per-role image path. Task Manager Details uses the image
  filename; Processes can use FileDescription. GUI verification of those tabs
  remains part of the Windows work in
  [#260](https://github.com/Hexpy-Games/butler/issues/260#issuecomment-5928900618).

## Layout and identity

`--prepare-process-links` creates or verifies exactly three hardlinks beside the
original Agent: macOS uses the full role name, Linux uses the short role name,
and Windows adds `.exe` to the full role name. It runs in Rust installer
staging, shell installer staging and Electron payload preparation. macOS bundle
normalization and Linux package staging rebuild hardlinks after packager copying
and before signing or archiving. Path APIs and argument arrays carry spaces and
parentheses without shell splitting. Permissions remain executable for every
hardlink; no alias binary is copied.

Aliases are checked as the same file, never by contents or name alone. Foreign
files/symlinks at a role name fail closed. Canonical identity and process-table
queries map only verified aliases back to the original binary. This protects
single-instance admission, control, restart and PID ownership checks even when
the OS reports a role-link path.

Version-directory rollback and uninstall/prune naturally include the aliases.
Standalone release archives retain the canonical `butler-agent` entry; the
installer creates aliases after extracting and verifying the archive. Older
binaries rejecting the private preparation command (exit 2) keep their original
layout; aliases are created by the target version, whose code owns identity
normalization. Old immutable installations without aliases launch the original
binary; Unix argv still carries the role. They gain role names on installation
of a new version. Service identity, manifests and binary digests stay unchanged.
Alias work is bounded to three file-identity checks at spawn/install, independent of
chat, event, transcript or memory database size. No polling or scans are added.

## Windows portable Electron App

`package:win` bundles `butler-agent.exe` and prepares the three role-named
NTFS hardlinks (`butler-agent (memory).exe`, `(restart).exe`, `(update).exe`).
The portable ZIP contains the whole `Butler-win32-x64` directory, renderer,
resources and notices. ZIP extraction turns links into copies; the bundled
loader restores these aliases as hardlinks before launching the child. Extract
onto a writable NTFS volume. Copies cannot satisfy Rust's file identity check.
The foreground child uses a stdin owner lease; its Electron diagnostics report
`direct_child`, with no Job Object or owner-death guarantee claimed.

Wave 1-A is unsigned portable packaging. Squirrel installer, auto-update and
interactive tray behavior remain outside this qualification. No release tag
is created; the Windows preview PR workflow runs the packaged App smoke.
