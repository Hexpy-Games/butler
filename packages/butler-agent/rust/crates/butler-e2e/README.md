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
`BUTLER_E2E_WORKSPACE_ROOT` selects the Rust workspace containing resources,
fixtures and cassettes when running a compiled harness on a different machine.

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
| `BUTLER_E2E_CODEX_AUTH_JSON` | Dedicated Codex-format `auth.json`, passed by path and refreshed atomically in place; never copied by the harness |
| `CODEX_AUTH_JSON` | Read-only Codex CLI fallback (default `~/.codex/auth.json`); never read by the harness |
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
subscription is used. CI uses the dedicated Codex login described in
[CONTRIBUTING.md](../../../../../CONTRIBUTING.md#live-e2e-oauth-setup-windows-owner-runner),
selected with `BUTLER_E2E_CODEX_AUTH_JSON`. A Butler test login
(`butler auth login --data ~/.butler-e2e-auth`) also works. Without either,
the harness falls back to the read-only Codex CLI file and LIVE-10 is
SKIPPED. Run the live tier with `--test-threads=1`; CI also serializes live
jobs across release branches so refreshes of the one profile cannot race.

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
normal stub CI suite. Native counters live in `butler-platform`: Linux supplies
procfs, macOS supplies footprint/disk I/O, and Windows supplies resident memory
and `GetProcessIoCounters` via sysinfo. Windows I/O includes buffered/network
transfers, a conservative storage upper bound; it is not a physical-disk-only
counter. Unsupported systems report the measurement unavailable. Linux RSS is
deliberately stricter than private heap size, but is not macOS `phys_footprint`.


## Storage concurrency comparison

`storage_concurrency` seeds a 1.3 GB App DB with 600 chats and 300,000 events,
then streams eight turns with 200 deltas each. The perf test checks exact rows,
ordered deltas, complete messages and current committed views while reporting
commits per turn, WAL bytes per turn, persistence p95 and session-view p95.
Run with a release agent, `BUTLER_E2E_TIER=stub`, `BUTLER_E2E_PERF=1` and one
test thread. Storage instrumentation and stream controls are opt-in on the
stub/perf tiers in both build profiles.

The before run normally disables read pools and App delta/transaction batching.
`BUTLER_E2E_STORAGE_MAIN_BIN` instead selects a separately built main agent for
that run. That binary needs the same opt-in commit/WAL/operation counters and
raw-delta/eight-stream controls; its storage implementation stays unchanged.
Both runs disable automatic checkpoints while counting WAL bytes, so the WAL
measurement includes all retained frames rather than only the last checkpoint
cycle. `idle_resources` additionally observes App and BTCC `data_version` over
all three idle windows and requires zero commits. Its fixture contains 5,000
turns, 200,000 App events, 30,000 native messages, 30,000 completed memory jobs
and more than 300 MB of metrics. These fixtures do not model the full 7 GB BTCC
DB or the 2,440-transcript corpus listed in [AGENTS.md](../../../../../AGENTS.md); report the measured
fixture scope with the results.

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

## Turn overhead at owner scale (PERF-02)

`perf_turn::perf_02_round_overhead_at_large_context` scripts 60 `read_file`
rounds with distinct 22 KB prose files, then a final answer. It measures the gap
from the end of each provider reply to arrival of the next complete request,
excluding synthetic-provider matching and model time. Only samples whose next
request transcript (`input`, excluding tools and instructions) is at least
1.4 MB enter the owner-scale p95; it must be below 20 ms.
Every request must contain the exact results so far, with their call IDs and
order; the final request carries all 60 files. Final delivery is checked too.
The diagnostic prefix hashes, token counts and longest common prefixes are
checked against an independent reconstruction with the uncached tokenizer.

This scenario uses the existing release-branch perf selector and
`BUTLER_E2E_PERF=1`; PR smoke excludes `perf_*`.

PERF-02 checks the selected agent's embedded build profile through
`--version --json` before starting the turn. A debug or unknown profile fails
with release build instructions, including when `BUTLER_E2E_BIN` overrides the
usual executable path. The harness itself may use either profile.

Run locally with a release agent:

```sh
BUTLER_E2E_TIER=stub BUTLER_E2E_PERF=1 BUTLER_E2E_SKIP_BUILD=1 \
BUTLER_E2E_BIN="$CARGO_TARGET_DIR/release/butler-agent" \
python3 ../../../.github/scripts/isolated.py cargo test -p butler-e2e \
  --test e2e perf_02_ -- --nocapture --test-threads=1
```

Linux x86_64 release measurements on 2026-10-06, before at `ca0212d27`
(the earlier SSE scan and message-facts cache), after with exact token-block
reuse, fewer serialization passes, and shared catalog construction:

| Measurement | Before | After |
| --- | ---: | ---: |
| Transcript bytes | 1,455,703 | 1,455,703 |
| Final request bytes | 1,508,906 | 1,508,906 |
| Owner-scale samples | 3 | 3 |
| Per-round p50 | 145.1 ms | 19.2 ms |
| Per-round p95 | 147.3 ms | 19.3 ms |

Both runs passed the exact history and final-delivery assertions. The after
run also passed the independent token assertions and the unchanged 20 ms gate.
The measured tree includes `origin/main` at `3379b7a6f` (the thin CLI split);
`98581771a` was subsequently merged with CI/docs changes only.
The margin is small: the instrumented run measured 20.4 ms p95 and failed the
gate. No assertion or budget was changed.

Profiling used the same release agent and scenario, with
`perf record -e cpu-clock:u -F 1999 -g --clockid mono --call-graph dwarf,32768`.
Samply unwound the captured DWARF stacks; a flamegraph was generated from
resolved stacks. `BUTLER_E2E_PROFILE=1` prints monotonic endpoints so analysis
includes only the three owner-scale reply-to-request gaps. There were 918
before and 138 after agent CPU samples; profiled p95 was 163.0 and 20.4 ms.
Inclusive percentages overlap. These are the top ten named application/library
frames, excluding generic Rust/Tokio/libc executor frames:

| Before frame | CPU % | After frame | CPU % |
| --- | ---: | --- | ---: |
| `CoreBPE::encode_ordinary` | 81.26 | `driver::obtain_reply` | 44.20 |
| `driver::obtain_reply` | 62.20 | `driver::run_iteration` | 42.03 |
| `fancy_regex::Matches::next` | 59.15 | `ProductionAgentLoop::run` | 28.26 |
| `fancy_regex::Regex::find_from_pos_with_option_flags` | 56.43 | `TurnContextProjection::project` | 22.46 |
| `fancy_regex::vm::run` | 54.47 | `model_round::project_context` | 22.46 |
| `catalog::estimate_tokens` | 52.83 | `RoutedRound::run` | 21.74 |
| `CoreBPE::count_ordinary` | 52.72 | `ModelProvider::run` | 21.74 |
| `RoutedRound::run` | 34.53 | `RoutedRound::run_round` | 21.01 |
| `ModelProvider::run` | 34.42 | `TokenizerOwner::block` | 15.94 |
| `RoutedRound::run_round` | 33.66 | `TurnContext::compacted` | 13.04 |

Repeated full-history regex/BPE work was the main cause. The replacement caches
exact source blocks only at proven o200k pre-tokenizer boundaries; counting
reuses lengths and encoding retains every token. Entries are bounded by bytes
and count, and changed bytes miss the cache. Context pressure and byte admission
share one serialization, request encoding reuses serialized diagnostic input,
unchanged diagnostic components reuse their bytes/hashes after ordered value
comparison, and image admission walks the already parsed body once. Catalog
construction reuses identical dynamic facts after fresh file reads, with fresh
observation times and current secret resolution. Unrelated tool results
are not parsed as work anchors. The earlier SSE scan and message-facts cache
were reverted.

Remaining after-profile work includes string escaping (11.59%), fresh-block BPE
(10.14%), SQLite statement preparation (12.32%), and SHA-256 (7.97%). Catalog
construction was 6.90% before its reuse; the final cache path is 0.72%. SQLite
and catalog state still remain current on each round.

Landing verification on the same Linux x86_64 host, with both agent and harness
in release mode and fresh HOME/BUTLER_DATA per run, initially failed at
20.1 ms p95. Subsequent serialization-only and diagnostic-hash changes still
failed at 20.4 and 20.5 ms. Reprofiling identified remaining string escaping
and SHA-256 work. Context sizing now reuses ordered serialized components;
diagnostic prefixes extend an exact SHA state after comparing all old bytes;
and the turn-owned request-digest cache reuses unchanged plain-message bytes
and extends the digest before the final array/object delimiters. Passthrough
JSON always uses the original request writer. All caches are bounded, and
mutations/truncations restart digest computation.

The first qualifying three consecutive unprofiled runs passed the unchanged
20 ms gate before CI exposed the fragmented-stream scan:

| Run | p95 per round | Transcript bytes | Final request bytes |
| --- | ---: | ---: | ---: |
| 1 | 18.6 ms | 1,455,703 | 1,508,906 |
| 2 | 17.5 ms | 1,455,703 | 1,508,906 |
| 3 | 18.1 ms | 1,455,703 | 1,508,906 |

Each run passed exact history, order/call-ID, final-delivery and independently
reconstructed prefix hash/token assertions. Existing format pins also compare
cached request digests with fresh serialization after append, mutation,
truncation and reordered passthrough JSON.

CI then exposed the expanded 200 KB fragmented SSE test timing out on both
Linux and macOS. Delimiter search now remembers its cursor and frame-size
validation counts only new UTF-8 bytes, retaining incomplete sequences and
exact lossy-decoder semantics. The local test fell from 1.33 to 0.68 seconds
without changing its content or timeout. After that change, PERF-02 passed
18.5/18.1 ms but failed its third run at 32.1 ms. A new profile identified
unchanged-block hash-table lookups; bounded ordered token chains now compare
complete bytes at the same position instead of rehashing unchanged blocks.

Final-tree verification passed three consecutive unprofiled release runs at
**19.5 / 18.5 / 17.5 ms p95**, each with the same 1,455,703-byte transcript,
1,508,906-byte request and all correctness assertions above. Format, strict
Clippy, source-check, touched-crate tests, runtime integration tests and the
12 existing context/token/tool/branch stub E2Es passed on this tree.
