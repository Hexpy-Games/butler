# Agent install layout

One layout and one `butler` command for every way the Agent gets installed:
`install.sh`, `npx @hexpygames/butler install`, the desktop App, and the Rust
`butler install/update/rollback/uninstall` commands. `deploy/install.sh` and
the Rust CLI both implement this page; change it first.

## Paths

| | macOS | Linux | Windows (later) |
|---|---|---|---|
| `AGENT_HOME` | `~/Applications/ButlerAgent` | `${XDG_DATA_HOME:-$HOME/.local/share}/butler/agent` | `%LOCALAPPDATA%\Butler\agent` |
| PATH entry | `~/.local/bin/butler` | `~/.local/bin/butler` | `%LOCALAPPDATA%\Butler\bin\butler.cmd` |

- `BUTLER_AGENT_HOME` overrides `AGENT_HOME`; `BUTLER_BIN_DIR` overrides the
  directory of the PATH entry.
- DATA stays `~/.butler` (`--data` > `BUTLER_DATA` > default, unchanged). It must
  not contain or sit inside `AGENT_HOME`; the Agent refuses to run otherwise
  (`butler_data_overlaps_installation`), and installers never write to DATA.

## Inside `AGENT_HOME`

```
AGENT_HOME/
  0.0.22-1a2b3c4d/          version dir: <version>-<first 8 hex of binarySha256>
    butler-agent            the executable
    butler -> butler-agent  symlink (archive layout, unused by the PATH entry)
    resources/
    native-agent-manifest.json   butler.native-agent-install.v1
  current  -> 0.0.22-1a2b3c4d   active version (relative symlink)
  previous -> 0.0.21-9f8e7d6c   what `current` pointed at before the last switch
  .staging-*                    scratch; stale ones may be deleted
```

- A version dir is the extracted standalone archive, unmodified (see
  `scripts/STANDALONE_AGENT.md`). `version` and `binarySha256` come from its
  `native-agent-manifest.json`; `version` is at most 64 characters of
  `[A-Za-z0-9._+-]`, starts with a letter or digit, and equals the release's.
- Versions are created by extracting into `.staging-*`, checking the tree
  (the binary matches the manifest digest and `doctor --check installation`
  passes) and renaming, so a version dir is always complete and verified before
  `current` moves. Only after the rename is the tree made read-only (a
  read-only directory cannot be renamed on macOS), so uninstall must
  `chmod -R u+w` before `rm -rf`. An existing version dir is reused only if it
  verifies the same way; otherwise it is replaced.
- `current` and `previous` change only by renaming a fresh symlink over the old
  one, never remove-then-create. A running Agent keeps using its old version dir
  until restarted.
- Retention: `butler install/update` keeps the three most recently installed
  versions plus the active one, `previous`, and any version a running service
  executes from, and prunes the rest. `install.sh` never prunes. Names that are
  not version dirs (and anything else foreign in `AGENT_HOME`, dot-prefixed
  scratch aside) are never touched.
- `previous` is written by the installer for `butler rollback`. Without it, a
  reader falls back to the newest other version dir.
- Windows: `current` becomes a one-line file holding the version dir name,
  because unprivileged symlinks are not available.

## The `butler` command

The PATH entry is a POSIX sh launcher. Its second line is the marker
`# butler-native-launcher v1` (the marker `host/service/cli_launcher.rs` reads
at line 2), so tools can recognize a launcher of ours and rewrite it, and must
leave any other file at that path alone:

```sh
#!/bin/sh
# butler-native-launcher v1
# Managed by Butler: rewritten by the installer.
exec '<AGENT_HOME>/current/butler-agent' --installation-root '<AGENT_HOME>/current' --resource-root '<AGENT_HOME>/current/resources' "$@"
```

An existing file at that path is handled as `butler install` does: a launcher
with the marker is rewritten; the pre-native Bun launcher (it mentions both
`butler.js` and `BUTLER_HOME`) is kept as `butler.previous` (an existing one is not overwritten)
and replaced; anything else, or a symlink (never followed), is left alone. The
shell installer then stops before installing anything, and `butler install`
reports `kept-foreign`.

It points at `current`, not at a version dir, so switching versions needs no
launcher rewrite. The Agent canonicalizes both roots, so they resolve to the
active version dir and satisfy the layout check (executable and resources inside
the installation root, `native-agent-manifest.json` at the root). The launcher
does not set `BUTLER_DATA`.

The App-bundled Agent (`.../bundled-agent/bin/butler-agent`, payload manifest
`butler.native-agent-payload.v1`) is a different, read-only layout and never
appears in `AGENT_HOME`. `DATA/bin/butler` (the older launcher, `cli_launcher.rs`)
is a second entry with a default `BUTLER_DATA`. It is never created, only
repointed: to `AGENT_HOME/current` once a CLI installation is active (by
`butler install/update/rollback`, and at every service start), otherwise to the
installation that started the service.

## Release assets

On `github.com/Hexpy-Games/butler/releases/download/v<ver>/`:

- `butler-agent-<ver>-<platform>.tar.gz` for `platform` in `darwin-arm64`,
  `linux-x64`, `linux-arm64`. The archive root is the version dir contents.
- `butler-<ver>-SHA256SUMS` covers every asset, archives included.
- `agent-update-manifest.json` and `agent-release-manifest.json` list one
  artifact per platform (`platform`, `artifact_url`, `sha256`). Consumers pick
  their own platform's entry and never one without a matching platform.
- `install.sh`, the shell installer that implements this page.
