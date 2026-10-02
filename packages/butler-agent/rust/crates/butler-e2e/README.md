# butler-e2e

Dev-only end-to-end harness. It runs the real `butler-agent` binary with an
isolated data dir, `HOME`/`CODEX_HOME` sandbox, gateway auth token, `TZ=UTC`
and an OS-assigned gateway port, and drives it only through gateway HTTP, `/events` and
`/events/live`, the CLI and the data dir. Model traffic goes to a local
record/replay provider reached through the product's own base-URL variables.

Spec: `SCENARIOS.md`, `PROVIDER_CONFIG.md` (E2E strategy notes).

## Run

Scenarios are opt-in: without `BUTLER_E2E_TIER` every scenario returns
immediately (so `cargo test --workspace` in the unit-test CI does not run
the stub tier twice; the `e2e` workflow runs it). Only the cassette lint
always runs. Source-check requires every Agent scenario to enter through
`butler_e2e::gate!()` before any executable statement; the binary helper also
refuses to build or locate an Agent when no tier is selected.

```sh
# stub tier: replays committed cassettes, live tests show as ignored
BUTLER_E2E_TIER=stub crates/butler-e2e/scripts/isolated-run.sh cargo test -p butler-e2e -- --test-threads=8

# live tier against the owner's test-only subscription login (~/.butler-e2e-auth)
BUTLER_E2E_TIER=live cargo test -p butler-e2e --test live -- --ignored --test-threads=1

# re-record cassettes for one test file (live provider, clean traffic)
BUTLER_E2E_TIER=live BUTLER_E2E_RECORD=1 cargo test -p butler-e2e --test turn
```

Use `scripts/isolated-run.sh` for every local test/check command. It preserves Cargo
caches, creates private HOME and BUTLER_DATA under TMPDIR, and removes both on exit.

The harness builds `butler-agent` itself (`cargo build -p butler-agent`) unless
`BUTLER_E2E_BIN` names a binary or `BUTLER_E2E_SKIP_BUILD=1`.

Port 0 is test-harness-only, accepted through `BUTLER_APP_SERVER_PORT` or
`--port=0`; a zero in `gateways/app.json` falls back to 18765. A zero override reports
`configured: false` and a null `serverUrl`; the bound endpoint is published
in the instance record.

The agent binds port 0 and the harness reads its published instance endpoint;
subsequent restarts keep that port. Readiness failures include the last 16 KiB
of agent stdout/stderr. The readiness deadline remains 90 seconds.

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
| Failure retention | successful sandboxes are deleted; last five failures are kept under `$TMPDIR/butler-e2e/failures`, with paths printed |
| `BUTLER_E2E_REPORT` | file that collects live `PASSED`/`SKIPPED` lines |

The live tier passes the test profile to the agent as an absolute
`BUTLER_CODEX_AUTH_PROFILE` (refreshes are written back to it; the harness
never reads the token values) and runs without `OPENAI_API_KEY`, so the
subscription is used. The profile comes from a separate test-only login
(`butler auth login --data ~/.butler-e2e-auth`, owner's browser); without
it the harness falls back to the read-only Codex CLI file and LIVE-10 is
SKIPPED. Run the live tier with `--test-threads=1` so two refreshes of the
one profile cannot race.

## Quota polling

The harness starts the agent with `BUTLER_PROVIDER_QUOTA_POLLING=0`, so a
recording holds only the requests its scenario makes. The quota scenarios
(`tests/quota.rs`) turn polling on with `Setup::quota_polling()`:

```sh
# USE-02: Codex wham/usage through the test profile (~/.butler-e2e-auth)
BUTLER_E2E_TIER=live BUTLER_E2E_RECORD=1 cargo test -p butler-e2e --test quota use_02

# USE-04: Z.AI Coding Plan quota/limit (quota endpoint only, no model calls);
# the key is read from ZAI_API_KEY and never written to the cassette
BUTLER_E2E_TIER=live BUTLER_E2E_RECORD=1 BUTLER_E2E_PROVIDER=zai \
  cargo test -p butler-e2e --test quota use_04
```

For `zai` the recorder's upstream is the origin `https://api.z.ai` and the
agent's `BUTLER_ZAI_BASE_URL` carries the Coding Plan path
(`config::base_path`), from which the product derives its quota URL.

USE-05 (`Setup::codex_login_refresh`) sends the Codex login refresh through
the recorder (`/oauth/*` is forwarded to `https://auth.openai.com`). Recording
it makes the test login expire, as LIVE-10 does, and the agent writes the
refreshed login back to the same profile; replay runs with a refreshable
placeholder login.

## Owner-scale usage and updates

USE-06 (`tests/usage_scale.rs`) writes an owner-sized data folder at test time
(44,000 usage rows and about 320 MB of transcripts, nothing committed) and
asserts that `/usage-monitor` answers a window or a session in milliseconds
without reading the transcripts, that the all-time view is a cache hit on its
second read, and that a session counts only its own usage. USE-07
(`tests/updates.rs`) points `BUTLER_UPDATE_MANIFEST` at a local server that
delays its answer and asserts that `GET /updates` never waits for it.

Reset times in usage replies are recorded relative to the recording time and
rounded to the hour (`{{EPOCH_MS+Δ}}`, `{{EPOCH_S+Δ}}`); replay turns them
into times relative to the replay, so no cassette pins a subscription
anniversary and none goes stale. After the sanitizer learns a rule, committed
cassettes are re-sanitized without new traffic:
`cargo run -p butler-e2e --bin e2e-resanitize -- <scenario>...`.

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
  account identifiers in JSON bodies (`account_id`, `user_id`, `email`)
  → `{{ACCOUNT}}` / `{{EMAIL}}` (the lint rejects any left);
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

## Install scenarios (INS-02..15)

`install_lifecycle`, `install_safety`, `install_versions`, `install_hardening`,
`install_app` and `install_systemd` drive the CLI install (`butler install`,
`update --apply`, `rollback`, `versions`, `service install`, `uninstall`) in a
sandbox with its own `HOME`, `BUTLER_AGENT_HOME` and `BUTLER_DATA`; see
`docs/install-lifecycle.md`. INS-02 and INS-08 build two archives around the
binary under test (a few hundred megabytes in a debug build) and take several
minutes; the others use small stand-in archives.

launchd and systemd belong to the user, not to the sandbox `HOME`, so the
harness sets `BUTLER_SERVICE_MANAGER=off` for every command: nothing reaches
the real manager, and login-start is registered with `--files-only`. Only INS-14
turns the manager on, and only when `BUTLER_E2E_SYSTEMD=1` (the Linux CI job
sets it after probing for a user manager). INS-15 needs Node and reports
SKIPPED without it.

Agent startup and restart wait for `/runtime-readiness` executor readiness as
well as health and the current PID's instance record. The dispatch-readiness
scenario deliberately holds the executor and observes the earlier health-only
state. Shutdown ordering, record-write faults and memory bootstrap holds run
in the stub tier in both debug and release builds, so strict budgets exercise the same
injected product operations. App and maintenance owners also honor the same
stub fixture clock in both profiles; a fixture day must not become a due daily
job on the host's real date.

## Idle resources at owner scale (PERF-IDLE)

`idle_resources` uses the PERF-01 App seed with larger event bodies, 30,000
native canonical messages, 30,000 completed memory windows and 888,000 metric
records. It runs only in the opt-in `perf` tier, on Linux with a release agent.
After two minutes of settling it takes three 60-second procfs samples, asserting
RSS below 100 MB and both `rchar` and `read_bytes` below 1 MB per minute. Checking
`rchar` catches scans even when the kernel serves every read from its page cache.
Each window also checks that all seeded content and projections remain present.

From `packages/butler-agent/rust`, with the build caches set before isolating HOME:

```sh
export CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup"
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
cargo build --release -p butler-agent -j 8
BUTLER_E2E_TIER=perf BUTLER_E2E_BIN="$CARGO_TARGET_DIR/release/butler-agent" \
  cargo test --release -p butler-e2e --test idle_resources -- --nocapture --test-threads=1
```

Use `cargo test` for this several-minute measurement, independently of the
normal stub CI suite. The procfs boundary lives in `butler-platform`; other
platforms report the measurement unavailable. Linux RSS is deliberately stricter
than private heap size, but it is not macOS `phys_footprint`.


## Wall-clock budgets in CI

Functional scenarios keep their original names and run in shared stub jobs on
Linux x64, Linux arm64 and macOS. `assert_wall_clock_budget!` always prints the
measurement and checks the strict upper bound only with `BUTLER_E2E_PERF=1`.
Content, ordering, latest-state and minimum injected-delay assertions remain
unconditional. Nontermination remains bounded by the existing nextest watchdog.

The dedicated Linux release job sets that flag and runs with one test thread.
`.github/scripts/e2e-perf-filter.py` selects `perf_*` tests plus whole binaries
containing the helper (including helper modules), and prints every budget's
source location before execution. The contention binary is also retained for its
minimum lock-hold assertion. PERF-IDLE uses its documented separate release
`cargo test` runner, because its five-minute sampling exceeds nextest's existing
watchdog. No budget or timeout is increased.

Budgets before PR #441's revision and after this correction (strict `<` bounds):

| Scenario / measurement | Budget | Before perf job | After perf job |
| --- | --- | --- | --- |
| ONB-02 provider 401 terminal | 30 s | enforced | enforced |
| PRJ-06 missing/hanging Git dashboard | 8 s | enforced | enforced |
| SETUP-03 local server probes | 5 s | enforced | enforced |
| SETUP-10 stray OAuth callback | 5 s | enforced | enforced |
| TURN-03 stop mid-stream | 10 s | enforced | enforced |
| TURN-05 stalled stream terminal | 40 s | enforced | enforced |
| Shutdown streaming / hung MCP / startup / blocked storage / record write (5) | 8 s each | enforced | enforced |
| Shutdown blocked control read (both orders) | 2 s | excluded | enforced |
| PROJ-DEVICE checkpoint revisit | 150 s | enforced | enforced |
| PROJ-BACKLOG complete projection | 150 s | excluded | enforced |
| Side-chat complete projection | 150 s | excluded | enforced |
| USE-07 reads: pending, initial, repeat, polling, refreshed (5) | 1 s each | enforced | enforced |
| USE-06 24h / session / all-time cold reads (3) | 90 s each | enforced | enforced |
| USE-06 warm / new transcripts / appended rows / all-time reads (7) | 300 ms each | enforced | enforced |
| PERF-01 retention settles | 120 s | enforced | enforced |
| PERF-01 session-view p95 | 150 ms | enforced | enforced |
| PERF-01 owner-scale delivery | empty delivery × 3 + 2 s | enforced | enforced |
| PERF-ASK-USER session-view p95 | 150 ms | enforced | enforced |
| PERF-IDLE memory, each of 3 windows | 100 MB | skipped (stub tier) | enforced |
| PERF-IDLE rchar / disk reads, each of 3 windows | 1 MB each | skipped (stub tier) | enforced |

Thus 31 upper wall-clock assertion sites become 34, with every previous bound
preserved. The new helper-contract E2E additionally proves that equality with a
zero budget fails only in the perf tier and that arguments are evaluated once.
The schedule contention's 5 s minimum hold and forced refresh's minimum network
delay are functional assertions retained in both shared and perf runs.

## Harness hygiene checks

`harness_hygiene` checks success cleanup, the five-failure retention bound, and
cleanup of the isolated command runner. Scenario tests call `finish()` only
once their assertions pass; CLI-only setups mark their sandbox successful.
A panic also retains a sandbox. The former unlimited `BUTLER_E2E_KEEP_DATA`
override no longer keeps successful runs.

Readiness requires the authenticated gateway, executor PID, and ready instance
nonce to agree. Deliberately held-dispatch tests inspect the served gateway
before executor readiness; normal startup and replacement waits use the full
predicate.

After `cargo nextest archive -p butler-e2e --archive-file /tmp/e2e.tar.zst`,
run `scripts/archive-relocation.sh /tmp/e2e.tar.zst` from the Rust workspace
(with `BUTLER_E2E_TIER=stub` and `BUTLER_E2E_BIN` naming the built agent).
It extracts to a new directory, verifies the fixture executable belongs to the
archive, and runs the unchanged hung-MCP shutdown assertions there.
