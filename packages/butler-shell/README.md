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
The live harness accepts `browser` (standalone view), `browser-link <url>` (the open chat’s message-link action), and `browser-state` (prints `LIVE BROWSER <json>` with view, active tab and tab metadata before `LIVE OK`), along with: `connected`, `open <chat>`, `new`,
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

The shell's `cef` cargo feature is macOS-only until the Windows D3D11 and Linux software-paint jobs add their frame types to `butler_cef_host::osr` and the matching `SurfaceSource` conversion. Run these commands from the repository root to launch a signed development bundle: unbundled `cargo run` cannot work because CEF helpers rendezvous through the bundle's Mach ports. The `--use-mock-keychain` switch belongs only in development/test launch arguments.

```sh
export CEF_PATH="${CEF_PATH:-$PWD/target/cef}"
python3 packages/butler-agent/rust/crates/butler-platform/cef/fetch.py --dest "$CEF_PATH"
cargo build --manifest-path packages/butler-agent/rust/Cargo.toml -p butler-cef --features cef --bin butler-cef-host -j 6
cargo build --manifest-path packages/butler-shell/Cargo.toml -p butler-shell --features cef --bin butler-shell -j 6
python3 packages/butler-agent/rust/crates/butler-platform/cef/stage.py --cef "$CEF_PATH" --target packages/butler-agent/rust/target/debug --out target/cef-shell
cp packages/butler-shell/target/debug/butler-shell target/cef-shell/ButlerCefHost.app/Contents/MacOS/butler-shell
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable butler-shell' target/cef-shell/ButlerCefHost.app/Contents/Info.plist
codesign --force --deep --sign - target/cef-shell/ButlerCefHost.app
BUTLER_CEF_DIR="$PWD/target/cef-shell/ButlerCefHost.app/Contents/Frameworks" target/cef-shell/ButlerCefHost.app/Contents/MacOS/butler-shell --use-mock-keychain
```

## Tests

`cargo test -p butler-shell` runs the data store's tests against a fake source.

## Licences

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
