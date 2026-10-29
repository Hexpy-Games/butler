# butler-e2e

Dev-only end-to-end harness. It runs the real `butler-agent` binary with an
isolated data dir, `HOME`/`CODEX_HOME` sandbox, gateway auth token, `TZ=UTC`
and an OS-assigned gateway port, and drives it only through gateway HTTP, `/events` and
`/events/live`, the CLI and the data dir. Model traffic goes to a local
record/replay provider reached through the product's own base-URL variables.

Configured fixtures also pin `user.timezone` to `UTC` in `butler.config.json`
alongside the fixture clock. `TZ` alone does not override the platform's host
timezone on macOS. Timezone scenarios can change the user's setting through
`PATCH /settings`; empty-installation fixtures retain the product default.

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

The harness builds `butler-agent` itself with `butler-agent/e2e-fixtures` unless
`BUTLER_E2E_BIN` names a binary or `BUTLER_E2E_SKIP_BUILD=1`. Prebuilt agents used
for browser import scenarios also need this feature to inject isolated profile
and key sources. Never enable it in shipped agents.

Put scenarios that require compiled-in hooks in a `requires_e2e_fixtures` module,
including their hook-arming helpers. The installed Windows runner passes
`--skip ::requires_e2e_fixtures::` to both test listing and execution. Stub/debug
runs omit that filter. This requirement belongs to the target executable, not
the harness's `debug_assertions`; new scenarios in these modules inherit it.

Every fault, barrier, fixed clock and storage/idle probe that a scenario arms with a
`BUTLER_E2E_*` variable exists only in that fixture build (`e2e-fixtures` in each
product crate). Shipped binaries contain none of them, and `butler-source-check`
ratchets any such name in shipped code (`source-check-e2e-hooks.txt`). Perf scenarios
use an optimized fixture build for the same reason.
`BUTLER_E2E_WEB_PROBE_BIN` names a prebuilt `butler-runtime` `web-access-smoke`
example; without it the web read scenario builds the example first.
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
| `BUTLER_E2E_PROVIDER` | required for live and record runs, no default: any catalog provider id (`zai`, `zai-api`, `openai`, `openai-subscription`, …) |
| `BUTLER_E2E_MODEL` / `BUTLER_E2E_MODEL_MATRIX` | `provider/model@effort`; the model is required, the matrix defaults to it. Recording uses only this model. CI reads both from the `live-e2e` environment variables `BUTLER_E2E_LIVE_PROVIDER` and `BUTLER_E2E_LIVE_MODEL` |
| `BUTLER_E2E_CHATGPT_AUTH_DIR` | `openai-subscription` only: dedicated ChatGPT auth directory containing `chatgpt.json` (default `~/.butler-e2e-auth/auth`); refreshed atomically in place, never copied by the harness |
| `BUTLER_E2E_API_KEY_ENV` | name of the variable holding the API key of an API-key provider (default `<PROVIDER>_API_KEY`); the harness registers it with the agent as that provider's credential |
| `BUTLER_E2E_BASE_URL` | upstream override |
| `BUTLER_E2E_RECORD=1` | record mode |
| `BUTLER_E2E_CASSETTES` | cassette root (default `crates/butler-e2e/cassettes`) |
| `BUTLER_E2E_LIVE_MAX_TURNS` | live spend guard (default 60) |
| Failure retention | successful sandboxes are deleted; last five failures are kept under `$TMPDIR/butler-e2e/failures`, with paths printed |
| `BUTLER_E2E_REPORT` | file that collects live `PASSED`/`SKIPPED` lines |

With `openai-subscription`, the live tier passes the auth directory to the agent as an absolute
`BUTLER_CHATGPT_AUTH_DIR` and runs without `OPENAI_API_KEY`, so the ChatGPT
plan is used. Create the dedicated registration with
`butler auth login --data ~/.butler-e2e-auth`. CI uses the runner's saved
registration in place; it never copies a CI secret or falls back to Codex CLI
credentials. Run the live tier with `--test-threads=1`; CI also serializes live
jobs across release branches so refreshes of the one registration cannot race.

## On-demand hedge evaluations

Like the perf scenarios (`BUTLER_E2E_PERF=1`), hedge evaluations require a
separate opt-in: `BUTLER_E2E_HEDGE_EVAL=1`. Without it, LIVE-11, LIVE-12
and the hedge-only `prewarm_shared_chromium` utility report `SKIPPED` even
when the live tier selects ignored tests. With it, their existing tier,
credential and browser-cache requirements apply. These are owner-run metrics,
not release CI gates.

```sh
BUTLER_E2E_TIER=live BUTLER_E2E_HEDGE_EVAL=1 \
  crates/butler-e2e/scripts/isolated-run.sh \
  cargo test -p butler-e2e --test e2e live::hedge -- --ignored --test-threads=1
```

`scripts/hedge_eval_v2.sh prepare <main_sha>` and `run --rounds N` set
`BUTLER_E2E_HEDGE_EVAL=1` for the prewarm and paired evaluation runs.
LIVE-12 and prewarm also need `BUTLER_E2E_BROWSER_CACHE`; the runner supplies it.

## Quota polling

The harness starts the agent with `BUTLER_PROVIDER_QUOTA_POLLING=0`, so a
recording holds only the requests its scenario makes. The quota scenarios
(`tests/quota.rs`) turn polling on with `Setup::quota_polling()`:

```sh
# USE-04: Z.AI Coding Plan quota/limit (quota endpoint only, no model calls);
# the key is read from ZAI_API_KEY and never written to the cassette
BUTLER_E2E_TIER=live BUTLER_E2E_RECORD=1 BUTLER_E2E_PROVIDER=zai \
  BUTLER_E2E_MODEL=zai/glm-5.3 cargo test -p butler-e2e --test quota use_04
```

For `zai` the recorder's upstream is the origin `https://api.z.ai` and the
agent's `BUTLER_ZAI_BASE_URL` carries the Coding Plan path
(`config::base_path`), from which the product derives its quota URL.

ChatGPT plan estimates come from model response headers when present.
Sign-in and refresh flows use the fake ChatGPT authority in the stub tier;
OAuth traffic is never forwarded by the cassette recorder.

## history usage and updates

USE-06 (`tests/e2e/usage_history.rs`) uses 1,600 usage rows and eight small transcripts
to check complete window, session and cached all-time results. USE-07
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
| ChatGPT discovery, JWKS, authorization and token endpoints | `BUTLER_CHATGPT_AUTH_ISSUER` |

The module doc cites the documented source (URL, pinned commit where the
docs live in a repository) of every shape. Values no document shows are
marked `synthetic` where they are defined. Nothing is recorded: no Ollama or
LM Studio server was available on the build hosts. The browser of the
sign-in flow is the test itself (`BUTLER_CHATGPT_OAUTH_PORT=0` picks a free port).

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

## Retained history and storage correctness

The App retention, terminal history, transcript history, memory restart recall,
coverage mirror, permissions, monitoring and usage scenarios use small synthetic
fixtures. They check complete content, ordering, identities, current state,
selective reclamation and recovery through the real service in the stub tier.
Fixture sizes follow the assertions being exercised, independently of any
individual installation.

`storage_concurrency` uses eight historical chats and 48 events before streaming
eight turns with 200 deltas each. It checks exact persisted rows, ordered deltas,
complete messages and current committed views. Optional storage instrumentation
reports commits, WAL bytes and latency without changing the stream assertions.

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
minimum lock-hold assertion.

The hooks idle observation runs in the serial perf tier with all three 60-second
windows. Its six-minute nextest deadline accommodates the 180-second observation,
startup, terminal retention settlement and shutdown. The Browser attached-host
idle observation retains its full 600 seconds with a twelve-minute deadline and
runs only against Browser-on builds. Both overrides name exactly one test.
Release archives and E2E selection use the same product feature metadata as the
native Agent. Browser-off builds run the public absence contract, excluding the
enabled Browser scenarios; the hidden feature is not a release prerequisite.

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
| PERF-01 history delivery | empty delivery × 3 + 2 s | enforced | enforced |
| PERF-ASK-USER session-view p95 | 150 ms | enforced | enforced |

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

## Tool round correctness

`perf_turn` scripts six distinct file reads and a final answer. Every request
retains complete, ordered tool history, and the final delivered answer is
checked exactly. Timing helpers retain the existing per-round budget.

## On-demand delegation evaluations

These owner-run evaluations are outside CI. No cassettes are recorded. The
ignored tests require `BUTLER_E2E_DELEGATION_EVAL=1` (set by the runner), an
explicit live tier and live credentials. `self-test` uses a local fake upstream
with the stub tier, including raw-body SHA-256 equality and zero executed
first-decision tools. It exercises namespaced Responses calls in both SSE item
and final JSON shapes, direct text, Anthropic routing/auth/cache wiring, exact
round admission, and both local Butler scripts against the new debug Agent.
It requires only the new debug Agent binary. The real merge-base executable is
exercised only by the owner's live runs.

From the Rust workspace, after sourcing the toolchain and preparing static ORT
as described in the Rust README:

```sh
crates/butler-e2e/scripts/delegation_eval.sh prepare
export BUTLER_E2E_CHATGPT_AUTH_DIR=/absolute/path/to/dedicated/auth
crates/butler-e2e/scripts/delegation_eval.sh first-decision --model openai/gpt-6-luna
# Anthropic: export ANTHROPIC_API_KEY, or name its variable with BUTLER_E2E_API_KEY_ENV.
crates/butler-e2e/scripts/delegation_eval.sh first-decision --model anthropic/claude-sonnet-5-5
crates/butler-e2e/scripts/delegation_eval.sh first-decision --model anthropic/claude-opus-5-5
crates/butler-e2e/scripts/delegation_eval.sh steward --model openai/gpt-6-luna
crates/butler-e2e/scripts/delegation_eval.sh steward --model anthropic/claude-opus-5-5 --cases w03-three-proposals,w07-small-fix,w09-translate-files
crates/butler-e2e/scripts/delegation_eval.sh self-test
```

`prepare` builds the merge-base of HEAD and origin/main in a disposable detached
worktree under TMPDIR, with a separate target directory, then builds the current
worktree in its shared debug target. Both enable `e2e-fixtures`. It removes the
old worktree, retaining its executable and SHA. All tests use the new harness;
`BUTLER_E2E_BIN` selects the variant's real Agent. Re-run prepare after changing
product code. No branch changes, commits or pushes are made.

Both modes default to `--variants old,new` and `--repeat 1`; first-decision
selects all 43 cases by default. In steward mode, `old` answers Butler locally
with `start_work`, `replace_work_plan` (steward mode and case checks),
`record_work_review` (plan accept), then `delegate_to_steward`, one per round.
`new` uses one-call delegation. Steward and Worker requests go upstream for both.
The old runtime has no plan gate: its refusal count is zero; review-before-mutation
is still scored from recorded tool order, including unsuccessful attempts.
`--cases id,id` narrows either evaluation. Each case uses an ordinary App chat with only its isolated workspace binding
seeded through the existing SessionBindingStore API; no project Ledger or setup
conversation is introduced. Seeded prior turns are answered locally with their fixture text. The product builds the complete provider
request, including the stable prefix, default phase-minimal tools, cache fields,
effort and conversation history. For Anthropic the verified-endpoint override
asserts that the loopback recorder supports the official cache contract, so the
real serializer emits the same breakpoints and default 1h TTL. The evaluator forwards those exact bytes via
the existing harness recorder transport once, retains the upstream first-round
calls for scoring, and answers the Agent with local text. Thus proposed tools
cannot execute. Headers carry the Agent's own provider authentication and are
never retained. API-key models are registered through the gateway using the
harness credential and explicit proxy URL before the evaluation turn. Butler's calls in steward mode are local; only Steward/Worker
rounds go upstream, with all Worker profiles selecting the evaluation model.

Routing counts any first-round `delegate_to_steward`, `start_work`, `continue_work`,
or steward-mode `replace_work_plan` as delegation; ask-only rounds are `ask`;
all others are direct. Reports include ordered calls, confusion counts, recall,
false-delegation rate, accuracy, raw provider usage and catalog-price USD
estimates. Each sample records `first_output_item` with only the raw first item's
`type`, `name`, and `namespace`, without arguments. Calls use the same namespace
projection as the product decoder. `extraction_mismatch` flags function-call
metadata (including `fc_` usage items) with no extracted calls; it cannot silently
score as a valid direct answer. Raw rows and the summary identify `invalid_reason`
(timeout, harness error, absent samples, upstream HTTP error, missing upstream or
Agent terminal result, or extraction mismatch). `outcome` distinguishes `completed`,
`limit_hit`, and `invalid`; the summary counts limit hits separately. Invalid and
limited requests remain in the denominator.
Steward scoring reads only the case's stopped, isolated BTCC database: Plan
Review binding, review-before-mutation attempts (including gate refusals), chosen
mode, successful Worker calls and terminal child/parent Work. Checks are
report-only for human review, without an LLM judge. The complete workspace and
journals are retained for inspection.

Steward defaults: 80 upstream model rounds and 900 seconds per case; adjust with
`--max-rounds` and `--seconds`. The round budget is shared by that case's Steward
and Workers only. Local Butler answers (including seeded history and all four old
steps), metadata discovery, and background answers consume no upstream rounds.
Exactly N upstream requests are admitted for `--max-rounds N`; request N+1 is
refused and reports `limit_hit`. Product HTTP retries consume the same allowance.
`upstream_rounds` counts admitted requests; report `rounds` counts collected samples.
The evaluator drains admitted requests on a limit hit before taking its snapshot;
a timeout can still leave fewer collected samples, with `invalid_reason: timeout`.
No round counter subtracts a local Butler round, so 79 samples under the default
80 is not by itself evidence of an off-by-one or a round-limit hit. Results and captured
request bodies are private temp artifacts under `$TMPDIR/delegation-eval/<timestamp>/`:
`raw.jsonl`, `results.json`, `summary.md`, and `workspaces/`. The runner prints the
summary path. They contain only synthetic cases and isolated paths; no headers,
keys or auth files are copied. Nothing is written into the cassette directory.

The offline App-chat capture measured 18,578 O200k instruction+tool tokens
for both the history and direct-answer sample cases (88,679 and 88,007 request
bytes respectively). Cost assumptions: 500 output tokens per first-decision request,
86 requests for a paired 43-case run. For measured instruction+tool prompt size
P (reported as `instruction_tool_tokens_o200k_estimate`), input cost is
`86 * P / 1e6 * input_price`, plus `86 * 500 / 1e6 * output_price`.
At measured P=18,578 the paired ordinary-input estimates are Luna $0.1813,
Sonnet $3.6254 and Opus $7.2508. Allowing 20% extra input for case/history/runtime
context gives about $0.22 for Luna. With no cache hits and all of that input
charged at Anthropic's default 1h cache-write rate, conservative estimates are
`86 * (18578 * 1.2 * 4 + 500 * 10) / 1e6 = $8.10` for Sonnet and
`86 * (18578 * 1.2 * 8 + 500 * 20) / 1e6 = $16.20` for Opus.
Old-variant and Claude prompt sizes have not been captured on this build Mac;
these estimates assume comparable prefixes and serializers. Actual cache reuse
reduces cost; more output or larger context increases it.
The catalog's per-million input/output prices are Luna $0.10/$0.50, Sonnet 5.5
$2/$10, Opus 5.5 $4/$20. O200k is an estimate for Claude and excludes dynamic
case context; actual reported tokens determine results. ChatGPT subscription
costs are API-equivalent estimates, not subscription charges. Steward costs are
workload-dependent. The offline Steward prefix+tools measured 14,460 O200k tokens.
Allowing growing tool history, an illustrative 10-case, 20-round/case run at 30k
input and 1k output tokens/round costs Luna
`200 * (30000 * .1 + 1000 * .5) / 1e6 = $0.70`; Opus is $28 at ordinary
input rates or $52 if every input token incurs a cold 1h cache write. The
three-case Opus subset is correspondingly $8.40 or $15.60. At the 80-round cap
these assumptions multiply by four, but growing context can increase the input
size further: these are forecasts, not dollar caps. No live spend was measured
on the build Mac.
