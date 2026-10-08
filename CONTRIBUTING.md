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

The workspace in `packages/butler-agent/rust` uses Rust 1.99.0, pinned in `rust-toolchain.toml`.

| Crate | Role |
| --- | --- |
| `butler-agent` | Thin executable and build provenance in `crates/butler-agent-cli`. |
| `butler-host` | Process composition, CLI, service and app server in `crates/butler-agent`; the library target remains `butler_agent`. It owns no domain logic. |
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

Paths in this table are relative to `packages/butler-agent/rust`. `tools/source-check` enforces code-shape limits, the test ratchet, platform boundaries and domain dependency rules. To find your way around, start at `crates/butler-agent-cli/src/main.rs` and `host::runtime`.

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

Read [AGENTS.md](AGENTS.md) before changing code. Run every test or check with a fresh temporary `HOME` and `BUTLER_DATA`; never use the owner's real `~/.butler`. Before you open a pull request, run:

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

cargo clippy -p butler-host -p butler-agent --all-targets --locked --no-default-features --features static-ort -- -D warnings
```

Run Clippy on the crates you changed; the example selects the Agent's static build. For default prebuilt builds, omit those feature flags. CI also runs the workspace with `cargo nextest run --workspace --locked`.

Test changed behavior E2E first: `BUTLER_E2E_TIER=stub cargo test --locked -p butler-e2e`. Use stub or replay only. Non-E2E tests require a `// test-category: race`, `security`, `pure-logic` or `format-pin` marker directly above the test function; source-check ratchets the counts in `source-check-tests.txt`, which may only decrease. Live cassette recording, when explicitly required, uses only `openai/gpt-6-luna`. The [harness README](packages/butler-agent/rust/crates/butler-e2e/README.md) covers tiers and recording.

Keep source files at most 500 lines and production functions at most 80 lines. OS-specific code belongs only in `butler-platform`; unsafe code is forbidden. Performance checks must verify complete, current results at owner scale (600+ chats, about 300k events and multi-GB stores). Follow the detailed request-path and idle-work rules in [AGENTS.md](AGENTS.md).

## Design system

App UI is built only from the Butler design system (`@/butler-ds`). Keep UI copy terse. Before you change UI:

- Read the [design-system skill](packages/butler-app/client/ui/src/libs/design-system/skills/butler-design-system/SKILL.md).
- Browse the DS Viewer at [butler.hexpy.games/ds](https://butler.hexpy.games/ds/), or locally: start the UI dev server (`npm --prefix packages/butler-app/client/ui run dev`) and open `http://127.0.0.1:5173/?visual=design-system`.
- Render DS Viewer pages to `.tmp/ds-viewer` with `bun run render <Component> [--theme=dark] [--mobile]`.

`lint:ds` and `lint:motion` are ratchets with per-file baselines that only shrink. After you remove violations, record the lower counts with `bun run lint:ds:baseline` or `bun run lint:motion:baseline`. Never raise a baseline.

## Manual

The manual lives in `packages/butler-site`, with Korean pages in `src/content/docs/ko` and the available English pages in `src/content/docs/en`. `bun run site:dev` serves it locally. `.github/workflows/site.yml` deploys `main` to [butler.hexpy.games/help](https://butler.hexpy.games/help/). When a change alters what users see or do, update the matching page.

## Project records

Specs, plans, decisions, implementation reports and experiment evidence belong in the [Project Ledger](packages/project-ledger/README.md). Write them through its CLI (`packages/project-ledger/bin/project-ledger`) or Butler's native tools. Never add work documents anywhere in the repo; keep scratch in `$TMPDIR`. Work and Task records reference canonical record IDs. Package READMEs remain the home for usage and API notes that belong to the source.

## Branches and CI

Work branches use `<type>/<slug>` with type `feat`, `fix`, `perf`, `refactor`, `ci`, `build`, `docs`, `test`, `chore` or `research`. Tool-named prefixes (`codex/`, `claude/`) and `batch/` are forbidden. PRs target `main`; candidate fixes use `fix/<v>-<slug>` from `release/<v>` and target that release branch. Merge commits everywhere; the coordinator admin-merges after smoke gates pass. There is no merge queue. Fetch and merge the base before pushing; never rebase a pushed branch.

PRs and main pushes run checks selected by changed paths, workspace tests, UI tests and packaging/install smoke checks, with **no E2E or perf**. Release pushes run integration: all groups, E2E, perf, live E2E (only `openai/gpt-6-luna`), Mac test packages and Windows smoke/installer builds. No nightly CI runs. After a release fix, only jobs with changed inputs or failed results run; successful unchanged jobs and matrix shards are reused through input receipts. Unchanged producer artifacts are restored for consumers. Integration receipts never reuse smoke results.

Release branches are `release/X.Y.Z` or `release/X.Y.Z-preview.N`. New features stay on main. Nothing syncs automatically: when asked, cherry-pick a main change with `-x` onto a release fix branch. After tagging, merge the release branch back to main as a merge commit, then delete it. A published-preview hotfix ships as the next preview, cut from the last tag or ready main.

## Releases

A release is a `vX.Y.Z` (or `vX.Y.Z-preview.N`) tag on a proven commit of `release/<v>`.

1. Set the new version in these files:
   - `VERSION`: the bundled agent version, also shown in the manual
   - `package.json`
   - `packages/butler-app/client/electron/package.json`: the app version
   - `packages/butler-progress-projection/package.json`
   - `packages/butler-npm/package.json`: the installer package version (the publish job sets it from the tag)
   - `packages/butler-agent/rust/crates/butler-agent-cli/Cargo.toml`
2. Refresh the lockfiles: `bun install`, `npm --prefix packages/butler-app/client/electron install`, and `cargo update --workspace` in `packages/butler-agent/rust`.
3. Write the release notes in `.github/releases/vX.Y.Z.md`. Preview tags (`vX.Y.Z-preview.N`) use `.github/releases/vX.Y.Z-preview.md`, and their macOS builds are not notarized.
4. Merge the notes/version changes into main, then cut `release/<v>` from `origin/main` (hotfixes may start from the last tag). The push starts integration and derives both test-build versions from the release branch.
5. The owner installs the Mac and Windows test builds while integration runs. Fix failures through `fix/<v>-<slug>` PRs into the candidate. Do not rerun passing jobs with unchanged inputs or retry flaky tests to get green; search existing issues first and link an open issue.
6. After complete integration proof and real-machine approval, the coordinator tags that exact SHA `v<v>`. Previews have standing approval; stable tags require the owner's explicit confirmation. `release.yml` blocks builds until every integration workflow gate, including live E2E on that SHA, is green directly or through matching integration receipts.
7. The tag builds all release platforms and publishes only after the assets and checksums exist. Stable npm publication runs through `.github/workflows/npm-publish.yml`; previews can be published by dispatching that workflow after desktop verification. After the first successful OIDC publish, the owner may delete the `NPM_ACCESS_TOKEN` repository secret. Dispatch `post-release-verify.yml` with the previous tag as baseline, then merge the release branch back to main as a merge commit.

Known-flaky failures can be waived by the coordinator for previews; stable waivers need the owner. On the linked **open issue**, post a comment containing exactly this JSON (fill in the values):

```json
{"kind":"integration-waiver","candidate":"0.1.0-preview.11","sha":"<full commit SHA>","workflow":"rust-quality.yml","job":"linux-perf/perf-idle","issue":123,"reason":"Known flaky failure; evidence linked in this issue"}
```

The proof reads issue comments, checks the open linked issue, the comment author's repository write/maintain/admin permission and their membership in the comma-separated repository variable `BUTLER_RELEASE_COORDINATORS` (the owner is also allowed), and scopes approval to the exact candidate, SHA, workflow and failed job. Missing or cancelled evidence cannot be waived. For stable waivers, the repository variable `BUTLER_RELEASE_OWNER` must name the owner who posts the approval. The coordinator tells the owner afterwards, using the waiver links printed in the release run. The proof also requires the aggregate gate (including complete Windows evidence) to pass; an aggregate failure needs a separately named `gate` waiver.

The app release gate fails when the bundled agent version changes and the app version doesn't. The gates are also available locally as the `release:*` scripts in `package.json`.

Windows preview releases include the unsigned Agent and Squirrel App installer.

### Recovering a failed release

Run `gh workflow run release.yml --ref release/<v> -f reuse_run_id=RUN_ID -f tag=vX.Y.Z` after the original run completes.
The optional tag must match that run; recovery verifies its commit and requires every platform artifact (including Windows for previews).
It skips builds, signing and smoke checks, then repeats manifest merging, npm packing, checksums and publication with asset replacement.
Stable npm recovery skips an already published version and sends a missing version through `.github/workflows/npm-publish.yml`; previews keep owner-controlled npm publication through that workflow. After the first successful OIDC publish, the owner may delete the `NPM_ACCESS_TOKEN` repository secret. Artifacts must still be retained; older runs without `app-darwin-arm64` cannot be recovered.

## Reporting issues

Open an issue in [GitHub Issues](https://github.com/Hexpy-Games/butler/issues) and include:

- the Butler version, your OS and your chip
- what you did, what you expected and what happened
- for a failed first-run setup, the output of **Copy diagnostics**, which hides tokens, secrets and user paths (see [Troubleshooting](https://butler.hexpy.games/help/troubleshooting/))
- for the standalone agent, the output of `butler doctor`

Leave API keys, personal data and private conversation content out of issues.

### CI stores in GHCR

CI SDKs use `ghcr.io/hexpy-games/butler-ci/native-deps:<target>-<recipe-hash>`.
Cargo build trees use `ghcr.io/hexpy-games/butler-ci/cargo-target:<platform>-<compatibility-key>`;
immutable generation tags append `--<run-id>-<attempt>`. Existing build jobs
publish on main/release pushes after building; two Cargo generations per key
survive. SDK keys are write once. Readers use `oras` 1.2.3 anonymously and verify
OCI SHA-256, sizes and the inner SDK/Cargo digests before adopting any output.
Missing public keys fall back to a build (CI static SDK consumers still require
publication). These packages are build inputs, outside the product Releases feed.

After the first publish, an organization package administrator must open each
package's **Package settings → Danger Zone → Change visibility → Public**:

- `butler-ci/native-deps` in [organization Packages](https://github.com/orgs/Hexpy-Games/packages)
- `butler-ci/cargo-target` in the same organization Packages list

The OCI `org.opencontainers.image.source` annotation links both packages to
`Hexpy-Games/butler`. Keep inherited repository access enabled so workflows can
publish/prune with `GITHUB_TOKEN` and `packages: write`; no PAT or added secret
is needed. Public visibility requires this one-time settings action because
GitHub's documented REST package API does not expose a visibility update.

Dispatch `native-deps.yml` on main and verify all four public targets first.
Then dispatch `ci-store-maintenance.yml` on main. It anonymously downloads every
current SDK and checks its outer and inner digests before deleting the four
original `native-deps-*` releases/tags and any `cargo-target-*` releases/orphan
tags. Any missing, private or corrupt SDK stops cleanup before the first deletion.
The maintenance job leaves model mirrors and product releases untouched.
