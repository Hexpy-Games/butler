# butler-shell (실험)

An experimental native desktop shell for Butler, built on gpui. It runs alongside the
Electron app and is not shipped.

- Its own Cargo workspace (not part of `packages/butler-agent/rust`), with the same
  toolchain and lints.
- gpui comes from the Butler fork of gpui-ce, pinned to tag `butler-lens-1`
  (`https://github.com/Hexpy-Games/gpui-ce`). The fork adds the Liquid Glass lens and
  the Windows Acrylic window material.
- The UI reads data only through `source::Source`. No agent connection is wired yet, so
  the app opens in its disconnected state.

## Build and run

```sh
cargo run --release -p butler-shell
```

On macOS the lens needs gpui's wgpu renderer, which the crate enables
(`gpui_platform/macos-wgpu`).

## Headless shots

The harness renders the shell connected to an in-memory fixture and disconnected, light
and dark, at 1x:

```sh
cargo test --release -p butler-shell -- --ignored shots
```

PNGs go to `target/shots`, or to `BUTLER_SHELL_SHOT_DIR` when it is set.

## Licences

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
