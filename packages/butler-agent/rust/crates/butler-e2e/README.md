# butler-e2e

Dev-only end-to-end harness. It runs the real `butler-agent` binary with an
isolated data dir, `HOME`/`CODEX_HOME` sandbox, gateway auth token, `TZ=UTC`
and free ports, and drives it only through gateway HTTP, `/events` and
`/events/live`, the CLI and the data dir. Model traffic goes to a local
record/replay provider reached through the product's own base-URL variables.

Spec: `SCENARIOS.md`, `PROVIDER_CONFIG.md` (E2E strategy notes).

## Run

```sh
# stub tier (default): replays committed cassettes, live tests show as ignored
cargo test -p butler-e2e

# live tier against the owner's ChatGPT subscription (Codex auth.json, read-only)
BUTLER_E2E_TIER=live cargo test -p butler-e2e --test live -- --ignored --test-threads=1

# re-record cassettes for one test file (live provider, clean traffic)
BUTLER_E2E_TIER=live BUTLER_E2E_RECORD=1 cargo test -p butler-e2e --test turn
```

The harness builds `butler-agent` itself (`cargo build -p butler-agent`) unless
`BUTLER_E2E_BIN` names a binary or `BUTLER_E2E_SKIP_BUILD=1`.

| Variable | Meaning |
|----------|---------|
| `BUTLER_E2E_TIER` | `stub` (default), `live` (missing credentials fail), `all` (missing credentials: `SKIPPED (no credentials: …)`) |
| `BUTLER_E2E_PROVIDER` | `openai-subscription` (default), `openai`, `opencode-go`, … |
| `BUTLER_E2E_MODEL` / `BUTLER_E2E_MODEL_MATRIX` | `provider/model@effort`; defaults `openai/gpt-6-sol@low` and `openai/gpt-6-sol@low,openai/gpt-6-luna@max` |
| `BUTLER_E2E_CODEX_PROFILE` | Butler OAuth test profile (default `~/.butler-e2e-auth/auth/openai-codex.json`, optional; needed only for LIVE-10) |
| `BUTLER_E2E_CODEX_AUTH_JSON` / `CODEX_AUTH_JSON` | Codex CLI auth file (default `~/.codex/auth.json`), passed by path; never read by the harness |
| `BUTLER_E2E_API_KEY_ENV` | name of the variable holding an API key (API-key providers) |
| `BUTLER_E2E_BASE_URL` | upstream override |
| `BUTLER_E2E_RECORD=1` | record mode |
| `BUTLER_E2E_CASSETTES` | cassette root (default `crates/butler-e2e/cassettes`) |
| `BUTLER_E2E_LIVE_MAX_TURNS` | live spend guard (default 60) |
| `BUTLER_E2E_KEEP_DATA=1` | keep scenario sandboxes (logs, data dir) |
| `BUTLER_E2E_REPORT` | file that collects live `PASSED`/`SKIPPED` lines |

The live tier sets `CODEX_AUTH_JSON` (or `BUTLER_CODEX_AUTH_PROFILE`) for the
agent and unsets `OPENAI_API_KEY` so the subscription is used. A dedicated
test-only login (`butler auth login --data ~/.butler-e2e-auth`) is optional and
needs the owner's browser.

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
