# butler-shell (실험)

An experimental native desktop shell for Butler, built on gpui. It runs alongside the
Electron app and is not shipped.

- Its own Cargo workspace (not part of `packages/butler-agent/rust`), with the same
  toolchain and lints.
- gpui comes from the Butler fork of gpui-ce, pinned to tag `butler-lens-2`
  (`https://github.com/Hexpy-Games/gpui-ce`). The fork adds the Liquid Glass lens and
  the Windows Acrylic window material.
- The UI reads data through `source::Source`, backed by `butler-shell-client`.
  It attaches to the instance in `--data`, `BUTLER_DATA`, or the platform data directory,
  and watches instance changes while disconnected. It never starts an agent.

## Build and run

```sh
cargo run --release -p butler-shell
```

On macOS the lens needs gpui's wgpu renderer, which the crate enables
(`gpui_platform/macos-wgpu`).

## Headless shots

`butler-shell-shots` renders the shell connected to an in-memory fixture (a chat, an approval,
the suggest-a-change dialog, a question, a new chat) and disconnected, light and dark, at 1x,
one PNG per state:

```sh
cargo run --release -p butler-shell --features shots --bin butler-shell-shots -- <dir>
```

For a real isolated agent, pass `<dir> --data <data-dir>` (and optionally `--dark`).
The live harness accepts commands on stdin: `connected`, `open <chat>`, `new`,
`send <text>`, `answer <text>`, `approval`, `exact <text>`, `modify`, `allow`, `deny`,
`cancel`, `disconnected`, `shot <name>` and `quit`. Each completed command prints
`LIVE OK`. The main Rust workspace's `butler-e2e` example `gpui_shell` drives these
with a local stub provider, stops/restarts its own agent, and saves both themes.

## Tests

`cargo test -p butler-shell` runs the data store's tests against a fake source.

## Licences

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
