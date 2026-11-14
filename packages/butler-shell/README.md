# butler-shell (실험)

An experimental native desktop shell for Butler, built on gpui. It runs alongside the
Electron app and is not shipped.

- Its own Cargo workspace (not part of `packages/butler-agent/rust`), with the same
  toolchain and lints.
- gpui comes from the Butler fork of gpui-ce, pinned to branch `feat/butler-port-gaps` (rev `d4e3761`)
  (`https://github.com/Hexpy-Games/gpui-ce`). The fork adds the Liquid Glass lens and
  the Acrylic window material (Windows Acrylic, the macOS sidebar vibrancy).
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
`compose`, `type <text>`, `key <keystroke>`, `send <text>`, `answer <text>`, `approval`, `exact <text>`, `modify`, `allow`, `deny`,
`cancel`, `disconnected`, `shot <name>` and `quit`. Frame commands are `url <url>`,
`size <width> <height>`, `click <anchor>`, `drag <anchor> <dx>`, `wait <ms>`,
`expect-anchor <name>`, `expect-no-anchor <name>`, `expect-scale <factor>`,
`expect-session <id|new>` and `expect-composer-focus`. Each completed command prints
`LIVE OK`. The main Rust workspace's `butler-e2e` example `gpui_shell` drives these
with a local stub provider, stops/restarts its own agent, and saves both themes.

## Browser blocks

`butler_ds::ui::blocks::{browser_pane, page_card, address_field, page_band}` port the in-app
browser's layout. `PageCard` drops Electron's native-view props (`NativeViewSlot`, `covered`,
`stillSrc`, `stillAlt`, `occluderSelector`, `onOcclusion`): the page is a texture the shell paints
inside the scene, in the same z-order as the DS around it, so no DOM layer can sit under or over a
native view and no still is needed. `page` is that surface, laid out exactly in the content area
(or the fitted viewport rect); `on_bounds_change` reports the rect, scale and radius the engine
sizes its view to.

## Tests

`cargo test -p butler-shell` runs the data store's tests against a fake source.

## Licences

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
