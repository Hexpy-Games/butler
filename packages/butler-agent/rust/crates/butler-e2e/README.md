# butler-e2e

Dev-only end-to-end harness. It runs the real `butler-agent` binary with an
isolated data dir, `HOME`/`CODEX_HOME` sandbox, gateway auth token, `TZ=UTC`
and free ports, and drives it only through gateway HTTP, `/events` and
`/events/live`, the CLI and the data dir. Model traffic goes to a local
record/replay provider reached through the product's own base-URL variables.

Spec: `SCENARIOS.md`, `PROVIDER_CONFIG.md` (E2E strategy notes).

## Run

Scenarios are opt-in: without `BUTLER_E2E_TIER` every scenario returns
immediately (so `cargo test --workspace` in the unit-test CI does not run
the stub tier twice; the `e2e` workflow runs it). Only the cassette lint
always runs.

```sh
# stub tier: replays committed cassettes, live tests show as ignored
BUTLER_E2E_TIER=stub cargo test -p butler-e2e

# live tier against the owner's test-only subscription login (~/.butler-e2e-auth)
BUTLER_E2E_TIER=live cargo test -p butler-e2e --test live -- --ignored --test-threads=1

# re-record cassettes for one test file (live provider, clean traffic)
BUTLER_E2E_TIER=live BUTLER_E2E_RECORD=1 cargo test -p butler-e2e --test turn
```

The harness builds `butler-agent` itself (`cargo build -p butler-agent`) unless
`BUTLER_E2E_BIN` names a binary or `BUTLER_E2E_SKIP_BUILD=1`.

| Variable | Meaning |
|----------|---------|
| `BUTLER_E2E_TIER` | unset: scenarios skipped; `stub`, `live` (missing credentials fail), `all` (missing credentials: `SKIPPED (no credentials: …)`) |
| `BUTLER_E2E_PROVIDER` | `openai-subscription` (default), `openai`, `opencode-go`, … |
| `BUTLER_E2E_MODEL` / `BUTLER_E2E_MODEL_MATRIX` | `provider/model@effort`; both default to `openai/gpt-6-luna@max` (owner decision: automated real calls never use gpt-6-sol or -astra) |
| `BUTLER_E2E_CODEX_PROFILE` | Butler OAuth test profile, the default live credential (default `~/.butler-e2e-auth/auth/openai-codex.json`); refreshable, so LIVE-10 runs against it |
| `BUTLER_E2E_CODEX_AUTH_JSON` / `CODEX_AUTH_JSON` | Fallback when no test profile exists: Codex CLI auth file (default `~/.codex/auth.json`), passed by path, read-only; never read by the harness |
| `BUTLER_E2E_API_KEY_ENV` | name of the variable holding an API key (API-key providers) |
| `BUTLER_E2E_BASE_URL` | upstream override |
| `BUTLER_E2E_RECORD=1` | record mode |
| `BUTLER_E2E_CASSETTES` | cassette root (default `crates/butler-e2e/cassettes`) |
| `BUTLER_E2E_LIVE_MAX_TURNS` | live spend guard (default 60) |
| `BUTLER_E2E_KEEP_DATA=1` | keep scenario sandboxes (logs, data dir) |
| `BUTLER_E2E_REPORT` | file that collects live `PASSED`/`SKIPPED` lines |

The live tier passes the test profile to the agent as an absolute
`BUTLER_CODEX_AUTH_PROFILE` (refreshes are written back to it; the harness
never reads the token values) and runs without `OPENAI_API_KEY`, so the
subscription is used. The profile comes from a separate test-only login
(`butler auth login --data ~/.butler-e2e-auth`, owner's browser); without
it the harness falls back to the read-only Codex CLI file and LIVE-10 is
SKIPPED. Run the live tier with `--test-threads=1` so two refreshes of the
one profile cannot race.

## Record / replay

- Cassettes: `cassettes/<scenario>/<n>.json` + `meta.json` (provenance,
  per-file SHA-256, structural fingerprint). `tests/cassette_lint.rs` fails on
  hash mismatches (hand edits) and on JWTs, keys, bearer strings, emails, home
  paths, account ids and canaries.
- Match key: path, model, effort, the text between `User request:` and
  `Current scope:` of the request's user message, and the item kinds after it
  (tool rounds). Replay is strict: an unmatched request answers 501 and fails
  the scenario as `HARNESS_ERROR`.
- Sanitization at record time: per-run values → `{{W}}`, `{{D}}`,
  `{{SANDBOX}}`, `{{NONCE}}`; secrets/personal data → fixed placeholders;
  `response.instructions`/`response.tools` echoes and account identifiers
  redacted; headers reduced to `content-type`, `retry-after`; chunks cut at
  SSE event boundaries with their arrival delay.
- Product ids the model echoes (Work ids) are named `{{ECHO_n}}` in order of
  first appearance and substituted at replay; a recording served again for an
  identical request (retry, resumed turn) gets re-minted provider object ids.
- Fault transforms (`src/e2e/faults.rs`) apply to recordings only: error from
  the library of real error replies (`cassettes/_errors/`), truncate / reset /
  stall after chunk k, and tool-call argument mutations. Argument mutations of
  the first call of one tool also apply while recording, so the model's real
  reaction to the resulting tool error is what the cassette holds.

## Loopback stand-ins (first-run setup)

The first-run setup scenarios (`tests/setup_*.rs`, SETUP-01..13, #230) need
no cassette: the agent talks to loopback stand-ins in `src/e2e/fake_servers.rs`
through the product's own address variables.

| Stand-in | Reached through |
|----------|-----------------|
| Local model server (`/api/tags`, `/v1/models`, `/v1/chat/completions`: streamed, cut, without `[DONE]`, or refusing to stream) | `BUTLER_OLLAMA_BASE_URL`, `BUTLER_LM_STUDIO_BASE_URL`, a registered local model's server URL |
| Provider model list that checks keys (OpenAI bearer, Anthropic `x-api-key`) | `OPENAI_BASE_URL`, `BUTLER_ANTHROPIC_BASE_URL` |
| OAuth token endpoint (`id_token`, JWT access token with the ChatGPT claims) | `BUTLER_CODEX_OAUTH_TOKEN_URL` |

The module doc cites the documented source (URL, pinned commit where the
docs live in a repository) of every shape. Values no document shows are
marked `synthetic` where they are defined. Nothing is recorded: no Ollama or
LM Studio server was available on the build hosts. The browser of the
sign-in flow is the test itself (`BUTLER_CODEX_OAUTH_PORT` picks a free port).

## Scenario decisions

Owner decisions that change what a `SCENARIOS.md` scenario asserts. The
scenario's doc comment cites its decision.

| Scenario | Decision | Recorded |
|----------|----------|----------|
| MIG-01 | Data folders from releases before the BTCC runtime store (an App DB without `agent-runtime/btcc.sqlite`) need not be supported ("옛데이터 폴더 지원 안해도돼"). MIG-01 asserts a refusal that names the folder, says what to do and writes nothing, instead of "opens with all content migrated". | Owner, 2026-09-27, to the session running the E2E product-gap work (#213) |
| TURN-03 | Stop keeps the partial text, marked stopped. | Owner, #211 |
| REC-02, REC-03 | A crash-interrupted turn is not resumed automatically; it ends failed with retry available, and no tool effect runs twice. | Owner, #211 |
| Q-02 | Stopping the running turn pauses the session queue; the next user input resumes it in order. | Owner, #211 |
| ONB-01, ACC-01..05 | A fresh install asks first (`ask_first`). Saved settings are not migrated: an install from before ask-first that never saved an access mode keeps full access (ACC-05). In ask-first, first-conversation onboarding, memory save and analysis of an attached image proceed without approval; nothing else new does, and an MCP tool still asks. Scenarios recorded before assume full access, which the harness sets (`Setup::access`). | Owner, #236 |
| SCHED-01..03 | A schedule runs with its own access mode, whatever its conversation's; English says "schedule" (`butler schedule`, `butler automation` a hidden deprecated alias). | Owner, #237 |
