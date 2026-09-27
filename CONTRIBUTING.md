# Contributing to Butler

This guide covers the repository layout, running Butler from source, the checks a change has to pass, and how releases are cut. To learn how to use Butler, read the [manual](https://hexpy-games.github.io/butler/docs/).

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/butler-app` | The desktop app: the Electron shell (`client/electron`), the React UI and design system (`client/ui`), and dev, lint and release scripts (`scripts`). |
| `packages/butler-agent` | The native agent: the Rust workspace (`rust`) and the resources shipped beside the binary (`resources`: prompts, personas, skills, templates). |
| `packages/butler-i18n` | English and Korean UI copy. |
| `packages/butler-progress-projection` | The event-to-progress projection behind live progress rows. |
| `packages/project-ledger` | The Project Ledger CLI (`pl`), record templates and skill. |
| `packages/butler-site` | The manual, built with Astro and deployed to GitHub Pages. |
| `deploy/app` | The app release gate, packager and smoke check. |
| `tests` | Unit tests (`unit`), smoke scripts (`smoke`), and shared fixtures and helpers. |
| `tools` | Repository-wide tools: the validation runner and the git hook setup. |

### Rust crates

The workspace in `packages/butler-agent/rust` uses Rust 1.91.0, pinned in `rust-toolchain.toml`.

| Crate | Role |
| --- | --- |
| `butler-agent` | The `butler-agent` executable: process composition, CLI, service and app server. It owns no domain logic. |
| `butler-core` | Leaf building blocks: JSON codecs, locale, text, the configuration file and the tool protocol. |
| `butler-turn` | The turn engine: the model and tool loop, authority, durable Work, transcripts and workspaces. |
| `butler-models` | Model providers, credentials and MCP clients. |
| `butler-runtime` | Context assembly, built-in tools, skills and web access. |
| `butler-memory` | Long-term memory, the user profile and work records. |
| `butler-ledger` | The Project Ledger index, project Work and dashboard signals. |
| `butler-gateway` | The local HTTP and WebSocket API the app talks to. |
| `butler-e2e` | A dev-only harness that drives the real binary with recorded model traffic. |
| `butler-test-support` | Shared test helpers. |

`tools/source-check` enforces file-size limits and the domain dependency rules. To find your way around, start at `crates/butler-agent/src/main.rs` and `host::runtime`.

## Prerequisites

- An Apple Silicon Mac to build the native agent. The TypeScript checks don't need it.
- [Bun](https://bun.sh) 1.3.11 or later.
- Node.js 22 and npm.
- Rust through rustup. The pinned toolchain installs on first use.
- Python 3.9 or later, the Xcode Command Line Tools and `jq`.
- Free disk space for the static ONNX Runtime build cache.

## Run from source

```sh
git clone https://github.com/Hexpy-Games/butler.git
cd butler
bun install                 # also points git at the hooks in .githooks
bun run app:client:install  # Electron and UI dependencies (npm)
bun run app:ui:build        # the agent payload includes the built UI
node packages/butler-app/client/electron/scripts/prepare-native-agent.mjs darwin arm64
```

`prepare-native-agent.mjs` builds a pinned static ONNX Runtime and a release build of `butler-agent`, then stages the binary and its resources in `packages/butler-app/client/electron/.native-agent-payload/bundled-agent`. The first run is slow. Later runs reuse the cache in `packages/butler-agent/rust/target/native-deps`. Run it again after you change the agent or its resources.

The development app doesn't build the agent. It starts the executable named by `BUTLER_NATIVE_AGENT_EXECUTABLE`, which must be an absolute path with a `resources` folder next to its `bin` folder:

```sh
export BUTLER_NATIVE_AGENT_EXECUTABLE="$PWD/packages/butler-app/client/electron/.native-agent-payload/bundled-agent/bin/butler-agent"
export BUTLER_DATA="$HOME/.butler-dev"  # keeps development data out of ~/.butler
bun run app:client:dev
```

`app:client:dev` starts Vite for the UI with hot reload and opens Electron against it. `bun run app:client` builds the UI and starts Electron without Vite. Both need `BUTLER_NATIVE_AGENT_EXECUTABLE`. An installed Butler uses the same default gateway port (18765), so quit it first or set `BUTLER_APP_SERVER_PORT` to another port.

## Checks

Before you open a pull request, run:

```sh
bun run check
```

| Command | What it runs |
| --- | --- |
| `bun run check` | `lint`, `typecheck` and the fast unit tests |
| `bun run lint` | ESLint, the design-system and motion lints, and Prettier and Stylelint for CSS |
| `bun run typecheck` | `tsc` for the repository and for the UI |
| `bun run test:unit` | Every test in `tests/unit` |
| `bun run check:full` | `check` plus the packaging tests |
| `bun run format` | Fixes what ESLint and Prettier can fix |
| `bun run site:check` | The manual's style and prose lints, tests, token sync check and `astro check` |

The pre-commit hook runs `lint` and `typecheck`. Scripts in `tests/smoke` drive the built UI, for example `bun run app:layout:smoke` and `bun run app:design-system:smoke`.

### Rust

Run these from `packages/butler-agent/rust`:

```sh
cargo fmt --all -- --check
cargo run --locked -p butler-source-check -- .
```

Clippy and anything that builds the agent need the pinned native dependencies. `prepare-static-ort-macos-arm64.py` prepares them, or reuses its cache, and prints their paths:

```sh
prepared="$(python3 scripts/prepare-static-ort-macos-arm64.py)"
export ORT_LIB_PATH="$(jq -r .ort_lib_path <<<"$prepared")"
export PROTOC="$(jq -r .protoc <<<"$prepared")"
export ORT_PREFER_DYNAMIC_LINK=0 ORT_SKIP_DOWNLOAD=1

cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --locked -p <crate> <filter>
```

For Clippy alone, `--protoc-only` prepares only `protoc`. Run the tests for the crate you changed. CI runs the whole workspace with `cargo nextest run --workspace --locked`.

The end-to-end scenarios run the real binary against recorded provider traffic: `BUTLER_E2E_TIER=stub cargo test --locked -p butler-e2e`. The [harness README](packages/butler-agent/rust/crates/butler-e2e/README.md) covers tiers and recording.

## Design system

App UI is built only from the Butler design system (`@/butler-ds`). Before you change UI:

- Read the [design-system skill](packages/butler-app/client/ui/src/libs/design-system/skills/butler-design-system/SKILL.md).
- Browse the DS Viewer: start the UI dev server (`npm --prefix packages/butler-app/client/ui run dev`) and open `http://127.0.0.1:5173/?visual=design-system`.
- Render DS Viewer pages to `.tmp/ds-viewer` with `bun run render <Component> [--theme=dark] [--mobile]`.

`lint:ds` and `lint:motion` are ratchets with per-file baselines that only shrink. After you remove violations, record the lower counts with `bun run lint:ds:baseline` or `bun run lint:motion:baseline`. Never raise a baseline.

## Manual

The manual lives in `packages/butler-site`, with the Korean pages in `src/content/docs/ko`. `bun run site:dev` serves it locally. `.github/workflows/site.yml` deploys `main` to GitHub Pages. When a change alters what users see or do, update the matching page.

## Project records

Specs, plans, decisions, implementation reports and experiment evidence belong in the [Project Ledger](packages/project-ledger/README.md). Write them through its CLI (`packages/project-ledger/bin/pl`) or Butler's native tools. Don't add project-management records under `docs/`. Work and Task records reference canonical record IDs. Package READMEs remain the home for usage and API notes that belong to the source.

## Releases

A release is a `vX.Y.Z` tag pushed from `main`.

1. Set the new version in these files:
   - `VERSION`: the bundled agent version, also shown in the manual
   - `package.json`
   - `packages/butler-app/client/electron/package.json`: the app version
   - `packages/butler-progress-projection/package.json`
   - `packages/butler-agent/rust/crates/butler-agent/Cargo.toml`
2. Refresh the lockfiles: `bun install`, `npm --prefix packages/butler-app/client/electron install`, and `cargo update --workspace` in `packages/butler-agent/rust`.
3. Write the release notes in `.github/releases/vX.Y.Z.md`.
4. Merge, then push the tag. `.github/workflows/release.yml` builds the macOS arm64 app and agent, runs the release gates and smoke checks, and publishes the files and a consolidated checksum list to the GitHub release.

The app release gate fails when the bundled agent version changes and the app version doesn't. The gates are also available locally as the `release:*` scripts in `package.json`.

<!-- TODO(0.1.0): document the Windows and Linux release jobs once their formats are decided. -->

## Reporting issues

Open an issue in [GitHub Issues](https://github.com/Hexpy-Games/butler/issues) and include:

- the Butler version, your OS and your chip
- what you did, what you expected and what happened
- for a failed first-run setup, the output of **Copy diagnostics**, which hides tokens, secrets and user paths (see [Troubleshooting](https://hexpy-games.github.io/butler/docs/troubleshooting/))
- for the standalone agent, the output of `butler doctor`

Leave API keys, personal data and private conversation content out of issues.

<!-- TODO: add SECURITY.md with a private channel for security reports. -->
