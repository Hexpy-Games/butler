# Contributing to Butler

This guide covers the repository layout, running Butler from source, the checks a change has to pass, and how releases are cut. To learn how to use Butler, read the [manual](https://butler.hexpy.games/help/).

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/butler-app` | The desktop app: the Electron shell (`client/electron`), the React UI and design system (`client/ui`), and dev, lint and release scripts (`scripts`). |
| `packages/butler-agent` | The native agent: the Rust workspace (`rust`) and the resources shipped beside the binary (`resources`: prompts, personas, skills, templates). |
| `packages/butler-npm` | The `@hexpygames/butler` installer wrapper for the native Agent. |
| `packages/butler-i18n` | English and Korean UI copy. |
| `packages/butler-progress-projection` | The event-to-progress projection behind live progress rows. |
| `packages/project-ledger` | The Project Ledger CLI (`pl`), record templates and skill. |
| `packages/butler-site` | The public site, [butler.hexpy.games](https://butler.hexpy.games): the manual (Astro) at `/help/` and the DS Viewer at `/ds/`, deployed to GitHub Pages. |
| `deploy/app` | The app release gate, packager and smoke check. |
| `tests` | TypeScript checks (`unit`), App smoke scripts (`smoke`), and shared fixtures and helpers. |
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
| `butler-platform` | OS-specific filesystem, process, credential-store and service operations. |
| `butler-e2e` | A dev-only harness that drives the real binary with stub or replay model traffic. |
| `butler-test-support` | Shared test helpers. |

Paths in this table are relative to `packages/butler-agent/rust`. `tools/source-check` enforces code-shape limits, the test ratchet, platform boundaries and domain dependency rules. To find your way around, start at `crates/butler-agent/src/main.rs` and `host::runtime`.

## Prerequisites

- Apple silicon macOS, or Linux x64 / arm64 with glibc, for the packaged native Agent and App. The example below uses macOS; the payload producer also accepts `linux x64` or `linux arm64` on a matching host.
- [Bun](https://bun.sh) 1.3.11 or later.
- Node.js 22 and npm.
- Rust through rustup. The pinned toolchain installs on first use.
- Python 3.9 or later and `jq`; Xcode Command Line Tools on macOS, or a C/C++ compiler on Linux. See the [native dependency recipe](packages/butler-agent/rust/scripts/STATIC_ORT.md).
- Free disk space for the static ONNX Runtime build cache.

## Run from source

The Agent is Rust; Bun runs repository tooling, not a second Agent. The App (desktop or browser) is the only conversation gateway.

```sh
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
git clone https://github.com/Hexpy-Games/butler.git
cd butler
bun install                 # also points git at the hooks in .githooks
bun run app:client:install  # Electron and UI dependencies (npm)
bun run app:ui:build        # the agent payload includes the built UI
node packages/butler-app/client/electron/scripts/prepare-native-agent.mjs darwin arm64
```

`prepare-native-agent.mjs` builds a pinned static ONNX Runtime and a release build of `butler-agent`, then stages the binary and its resources in `packages/butler-app/client/electron/.native-agent-payload/bundled-agent`. The first run is slow. Later runs reuse the cache in `${CARGO_TARGET_DIR:-packages/butler-agent/rust/target}/native-deps`. Run it again after you change the agent or its resources.

If you already have a `butler-agent` binary, set `BUTLER_NATIVE_AGENT_EXECUTABLE` to it before you run `prepare-native-agent.mjs`. The script then skips the ONNX Runtime and `cargo` builds and stages that binary with the current resources and UI. It fails if the path is missing, not executable, or inside the payload it replaces.

The development app doesn't build the agent. It starts the executable named by `BUTLER_NATIVE_AGENT_EXECUTABLE`, which must be an absolute path with a `resources` folder next to its `bin` folder:

```sh
export BUTLER_NATIVE_AGENT_EXECUTABLE="$PWD/packages/butler-app/client/electron/.native-agent-payload/bundled-agent/bin/butler-agent"
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
export BUTLER_APP_SERVER_PORT=28765
bun run app:client:dev
```

`app:client:dev` starts Vite for the UI with hot reload and opens Electron against it. `bun run app:client` builds the UI and starts Electron without Vite. Both need `BUTLER_NATIVE_AGENT_EXECUTABLE`. Use a separate development port as above; leave the installed Butler service running. Unset `BUTLER_NATIVE_AGENT_EXECUTABLE` before you rebuild the payload, since it points inside it.

## Checks

Read [AGENTS.md](AGENTS.md) and [plans/README.md](plans/README.md) before changing code. Run every test or check with a fresh temporary `HOME` and `BUTLER_DATA`; never use the owner's real `~/.butler`. Before you open a pull request, run:

```sh
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
bun install --frozen-lockfile --ignore-scripts
bun run check
```

| Command | What it runs |
| --- | --- |
| `bun run check` | `lint`, `typecheck` and the fast unit tests |
| `bun run lint` | ESLint, the design-system and motion lints, Prettier and Stylelint for CSS, and `lint:repo` |
| `bun run lint:repo` | Rejects tracked symlinks that are absolute, leave the repository or point into `.claude/worktrees` |
| `bun run typecheck` | `tsc` for the repository and for the UI |
| `bun run test:unit` | Every test in `tests/unit` |
| `bun run check:full` | `check` plus the packaging tests |
| `bun run format` | Fixes what ESLint and Prettier can fix |
| `bun run site:check` | The manual's style and prose lints, tests, token sync check and `astro check` |
| `bun run site:build` | The whole site in `packages/butler-site/dist`: the manual, the DS Viewer at `/ds/`, and a check of the output |

The pre-commit hook runs `lint` and `typecheck`. When you change dependencies, regenerate the third-party notices with `node deploy/licenses/generate.mjs`; CI checks them with `--check`. Scripts in `tests/smoke` drive the built UI, for example `bun run app:layout:smoke` and `bun run app:design-system:smoke`.

### Rust

Run these from `packages/butler-agent/rust`, keeping `CARGO_HOME` and `RUSTUP_HOME` on their existing cache/toolchain paths:

```sh
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
cargo fmt --all -- --check
cargo run --locked -p butler-source-check -- .
```

Development and CI default to official prebuilt ONNX Runtime binaries. Prepare only `protoc` for those builds with `python3 scripts/prepare-static-ort.py --protoc-only` and export its reported path as `PROTOC`.

Release payloads use the pinned static build. `prepare-static-ort.py` prepares it for the host, or reuses its cache:

```sh
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
prepared="$(python3 scripts/prepare-static-ort.py)"
export ORT_LIB_PATH="$(jq -r .ort_lib_path <<<"$prepared")"
export PROTOC="$(jq -r .protoc <<<"$prepared")"
export ORT_PREFER_DYNAMIC_LINK=0 ORT_SKIP_DOWNLOAD=1

cargo clippy -p butler-agent --all-targets --locked --no-default-features --features static-ort -- -D warnings
```

Run Clippy on the crates you changed; the example selects the Agent's static build. For default prebuilt builds, omit those feature flags. CI also runs the workspace with `cargo nextest run --workspace --locked`.

Test changed behavior E2E first: `BUTLER_E2E_TIER=stub cargo test --locked -p butler-e2e`. Use stub or replay only. Non-E2E tests require a `// test-category: race`, `security`, `pure-logic` or `format-pin` marker directly above the test function; source-check ratchets the counts in `source-check-tests.txt`, which may only decrease. Live cassette recording, when explicitly required, uses only `openai/gpt-6-luna`. The [harness README](packages/butler-agent/rust/crates/butler-e2e/README.md) covers tiers and recording.

Keep source files at most 500 lines and production functions at most 80 lines. OS-specific code belongs only in `butler-platform`; unsafe code is forbidden. Performance checks must verify complete, current results at owner scale (600+ chats, about 300k events and multi-GB stores). Follow the detailed request-path and idle-work rules in [plans/README.md](plans/README.md).

## Design system

App UI is built only from the Butler design system (`@/butler-ds`). Keep UI copy terse. Before you change UI:

- Read the [design-system skill](packages/butler-app/client/ui/src/libs/design-system/skills/butler-design-system/SKILL.md).
- Browse the DS Viewer at [butler.hexpy.games/ds](https://butler.hexpy.games/ds/), or locally: start the UI dev server (`npm --prefix packages/butler-app/client/ui run dev`) and open `http://127.0.0.1:5173/?visual=design-system`.
- Render DS Viewer pages to `.tmp/ds-viewer` with `bun run render <Component> [--theme=dark] [--mobile]`.

`lint:ds` and `lint:motion` are ratchets with per-file baselines that only shrink. After you remove violations, record the lower counts with `bun run lint:ds:baseline` or `bun run lint:motion:baseline`. Never raise a baseline.

## Manual

The manual lives in `packages/butler-site`, with Korean pages in `src/content/docs/ko` and the available English pages in `src/content/docs/en`. `bun run site:dev` serves it locally. `.github/workflows/site.yml` deploys `main` to [butler.hexpy.games/help](https://butler.hexpy.games/help/). When a change alters what users see or do, update the matching page.

## Project records

Specs, plans, decisions, implementation reports and experiment evidence belong in the [Project Ledger](packages/project-ledger/README.md). Write them through its CLI (`packages/project-ledger/bin/pl`) or Butler's native tools. Don't add project-management records under `docs/`. Work and Task records reference canonical record IDs. Package READMEs remain the home for usage and API notes that belong to the source.

## Releases

A release is a `vX.Y.Z` tag pushed from `main`.

1. Set the new version in these files:
   - `VERSION`: the bundled agent version, also shown in the manual
   - `package.json`
   - `packages/butler-app/client/electron/package.json`: the app version
   - `packages/butler-progress-projection/package.json`
   - `packages/butler-npm/package.json`: the installer package version (the publish job sets it from the tag)
   - `packages/butler-agent/rust/crates/butler-agent/Cargo.toml`
2. Refresh the lockfiles: `bun install`, `npm --prefix packages/butler-app/client/electron install`, and `cargo update --workspace` in `packages/butler-agent/rust`.
3. Write the release notes in `.github/releases/vX.Y.Z.md`. Preview tags (`vX.Y.Z-preview.N`) use `.github/releases/vX.Y.Z-preview.md`, and their macOS builds are not notarized.
4. Merge, then push the tag. `.github/workflows/release.yml` builds the macOS arm64 App and Agent, Linux x64 / arm64 Agent archives and DEBs, and an Arch x64 App package. It runs release gates and smoke checks, attaches the installer and consolidated checksums, then publishes the release after the required assets exist. Hyphenated tags are prereleases; stable tags feed `releases/latest`. The npm job then publishes `@hexpygames/butler` (`latest` for stable, `next` for previews).

The app release gate fails when the bundled agent version changes and the app version doesn't. The gates are also available locally as the `release:*` scripts in `package.json`.

Windows has compile-check coverage, but no release package.

## Reporting issues

Open an issue in [GitHub Issues](https://github.com/Hexpy-Games/butler/issues) and include:

- the Butler version, your OS and your chip
- what you did, what you expected and what happened
- for a failed first-run setup, the output of **Copy diagnostics**, which hides tokens, secrets and user paths (see [Troubleshooting](https://butler.hexpy.games/help/troubleshooting/))
- for the standalone agent, the output of `butler doctor`

Leave API keys, personal data and private conversation content out of issues.
