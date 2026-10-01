# Agent process roles

Only OS processes get labels; tasks inside the service do not imply a separate
process. English role labels are lowercase. The service keeps `butler-agent`.

| Process / caller | Launch | Monitor name | argv[0] |
| --- | --- | --- | --- |
| Layout preparation: installer/packager | `--prepare-process-links` before aliases exist | `butler-agent` | unchanged |
| Main service: CLI, login manager, Electron | `service run --data D --detached`, or desktop stdio entrypoint with installation/resource roots | `butler-agent` | unchanged |
| Embedding owner | `--private-embedding-worker`, `BUTLER_DATA=D`, piped stdin/stdout, kill on drop | `butler(memory)` | `butler-agent (memory)` |
| MCP restart tool | `restart --data D --json --requested-by mcp`, installation/resource roots | `butler(restart)` | `butler-agent (restart)` |
| Service restart handoff | `service restart-handoff --data D --quiet`, roots, identity via stdin, detached | `butler(restart)` | `butler-agent (restart)` |
| Installer/update lifecycle helper | selected installation's `start`/`restart`/`stop --json --data D`, roots | `butler(update)` | `butler-agent (update)` |

Scheduler, memory maintenance, BTCC workers, App HTTP gateway and MCP server are
in-process tasks. There is no scheduler process of the Agent binary. Electron's
macOS menu bar helper is a separate Swift executable (`Butler Menu Bar Helper`),
not another invocation of the Agent. External tools, shells, browser binaries
and provider processes retain their own names.

## OS monitor behavior

- macOS: verified hardlinks preserve signed binary bytes. Symlinks were tested
  and resolve to the original name in `proc_name`. Hardlinks expose the alias in
  `proc_name` (the full process name) and in `top`. Names fit the short kernel
  command limit, so `top` shows the entire role. `ps -ww -axo pid,comm,args`
  shows the full role in args; its comm column is width-limited argv[0] on
  this Mac (ucomm selects the short kernel name). Activity Monitor's native
  name is qualified through `proc_name`; no GUI screenshot was taken.
- Linux: the basename and leader `comm` are at most 15 bytes, explicitly set
  through safe `nix::sys::prctl::set_name` on the main thread. `ps`/`top` and
  System Monitor using comm show the short role; argv/command-line modes of
  `ps`/`htop` show the full role. The E2E asserts `/proc/PID/comm` on Linux CI.
- Windows: currently `butler-agent.exe`. Task Manager Details uses the image
  filename; Processes can use FileDescription. Changing argv[0] or a thread
  description cannot qualify either. Per-role images, real file identity,
  packaging and both GUI tabs are deferred to the Windows work in
  [#260](https://github.com/Hexpy-Games/butler/issues/260#issuecomment-5928900618).

## Layout and identity

`--prepare-process-links` creates or verifies exactly three hardlinks beside the
original Agent. It runs in the Rust installer staging directory, shell installer
staging directory, and Electron payload preparation. macOS bundle normalization and Linux package staging
rebuild hardlinks after the packager's copying and before signing or archiving.
Permissions remain executable for every hardlink; no alias binary is copied.

Aliases are checked by device/inode, never by contents or name alone. Foreign
files/symlinks at a role name fail closed. Canonical identity and process-table
queries map only verified aliases back to the original binary. This protects
single-instance admission, control, restart and PID ownership checks even when
macOS reports the most recently looked-up hardlink path.

Version-directory rollback and uninstall/prune naturally include the aliases.
Older binaries rejecting the private preparation command (exit 2) keep their
original layout; aliases are created by the target version, whose code owns
identity normalization. Old immutable installations without aliases launch the original
binary; Unix argv still carries the role. They gain GUI naming on installation
of a new version. Service identity, manifests and binary digests stay unchanged.
Alias work is bounded to three metadata checks at spawn/install, independent of
chat, event, transcript or memory database size. No polling or scans are added.
