# Butler Agent Rust workspace

This workspace contains the native agent library and standalone `butler-agent` service under
`crates/butler-agent` (the `butler-host` library) and `crates/butler-agent-cli` (the thin `butler-agent` binary), plus development quality tooling. The current executable connects the existing
durable App input queue to canonical conversation preparation, the native provider/tool loop,
and durable App reply/progress transcripts. It drains owned work and stores on shutdown and
reopens an activated native data root on restart.

The previous frozen macOS arm64 native build passed isolated service, tool, memory, App HTTP,
standalone and Desktop package paths, including bundled native readiness and owned shutdown.
The real-model GPT-6 Sol campaign completed all 30 native tasks; it produced no valid paired
performance comparisons because the Bun arm failed its accuracy conditions. This checkout's
newer changes still require a final build and existing-DATA rehearsal before replacing the
running Butler. Windows and Linux runtime releases and hosted CI have not been validated.
Electron and frontend code remain JavaScript.

Installation resources resolve from the actual executable directory (or the Desktop bundle's
native agent resource directory). `BUTLER_HOME`, the working directory, and the source checkout
are not installation authorities. Runtime writes belong in `BUTLER_DATA`; the installation
must remain unchanged. For local runs, use an **isolated** `BUTLER_DATA` and the existing
`butler.config.json` and provider environment. The service consumes the existing file queue
under `runtime/inbound-events`, rather than a new stdin protocol. Stop it with SIGINT/SIGTERM
or its existing `locks/butler-shutdown` flag. Existing installed processes are not replaced.

While a session waits for a delegated worker, OpenAI routes keep their last request prefix
warm with invisible one-word requests. The default interval is four minutes and the wait cap
is 45 minutes. Set `BUTLER_PROMPT_CACHE_KEEPALIVE=off` to disable, or set
`BUTLER_PROMPT_CACHE_KEEPALIVE_INTERVAL_SECONDS` and
`BUTLER_PROMPT_CACHE_KEEPALIVE_CAP_SECONDS` to positive seconds (at most 86400).
Snapshots stay in memory, limited to 128 sessions and a 32 MiB retention charge
(four times serialized request bytes). Maintenance is skipped when that capacity is exceeded.
Each completed ping appends usage to `metrics/prompt-cache-usage.jsonl` with
`prefixDiagnostics.trigger=keepalive`. Inputs, cancellation, session close and shutdown stop
maintenance immediately; a failed ping stops that wait without retries. Local and Anthropic
routes do not send maintenance requests. Existing fields before input remain unchanged;
API-key requests append or lower an output cap after input to 16 tokens (preserving a smaller
existing cap), while Codex uses the one-word
instruction because it rejects output caps.

Development and CI builds use the official prebuilt ONNX Runtime binaries provided by `ort`.
Release package builds explicitly select the repository-owned [static dependency recipe](scripts/STATIC_ORT.md)
and build ONNX Runtime from its pinned source inputs. The existing Electron native producer
prepares that dependency cache and builds the packaged executable. Do not use an old ad hoc
ORT build directory as an undocumented prerequisite.

**Windows preview (x64).** In an x64 Visual Studio developer shell, prepare the static ORT
cache with `python scripts\prepare-static-ort.py` (a short `CARGO_TARGET_DIR`, see the recipe),
set `ORT_LIB_PATH` and `PROTOC` from its output with `ORT_PREFER_DYNAMIC_LINK=0` and
`ORT_SKIP_DOWNLOAD=1`, and run `cargo build --release --locked -p butler-agent`. Lay the binary
out as `<install>\bin\butler-agent.exe` next to a copy of `packages/butler-agent/resources` in
`<install>\resources`, and run it with `--installation-root <install> --resource-root
<install>\resources` (no subcommand runs the service; `stop`, `status`, `doctor` as on Unix).
`butler stop` stops a Windows service through its control endpoint's `service_stop` command
(the DATA shutdown flag while it is still starting) and ends it through a held process handle
after the grace period; the service has no SIGTERM there. Not yet on Windows: OS-enforced read-only command isolation, write protection of
program files, Task Scheduler registration, an owner-only access list on a DATA folder outside
`%USERPROFILE%`, and the `butler.exe` command launcher (see `butler_platform::launcher`).
Observation commands in ask-first use exact-command approval when the host lacks
read-only isolation; full access runs directly. Results record `sandbox: unisolated`.
Strict read-only Turns still require a sandbox. Protected data and credential paths
remain guarded; lexical screening is not an OS sandbox.
Commands the agent runs go through `cmd.exe` or PowerShell. A `butler restart` whose output is a pipe holds
that pipe open until the new service exits, because Windows children inherit every inheritable
handle and safe Rust cannot clear that; a terminal or file output is unaffected. Time zones
come from the rules embedded in the executable (`butler_platform::time_zone`).

The executable has passed an isolated source-queue smoke through a local mock provider,
physical file read, canonical persistence, reply transcript, close, and restart. A further
13-round mock-provider run queried a previous conversation, reopened its exact source, and
created, reviewed, and completed Work through actual journaled tool calls. Another run used
ten foreground and two semantic mock-provider calls to prove completion registration, recall,
exact source reads, workspace list/read, and recall again after restart. This is not
a real-model comparison or a performance benchmark.

Use the narrow checks relevant to a change from this directory; do not rerun the full test
suite for every leaf. Style and structural checks are:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo run --locked -p butler-source-check -- .
```

Use `cargo test --locked -p butler-host <affected behavior>` for a meaningful behavior check.
The final migration must pass the full required checks. This checkout passed strict Clippy on
macOS arm64 after the agent delta changes.

The source checker counts physical lines in every handwritten `.rs` file, including comments,
blank lines, and inline tests. Files from 400 through 500 lines require a responsibility review and
pass with a notice. Files over 500 lines fail. `.git` and `target` directories are excluded. Rust
source symlinks and directory symlinks are rejected so they cannot bypass the scan.

Behaviour is tested end to end in `crates/butler-e2e`. The checker counts every other test
function (`#[test]`, `#[tokio::test]`) per package against `source-check-tests.txt`, and the
counts may only shrink. A test kept outside the E2E harness carries a marker comment directly
above it naming why it cannot be a scenario: `// test-category: race`, `security`, `pure-logic`
or `format-pin`. Unmarked tests are waiting for E2E coverage; their count may only shrink too.
After deleting tests, ratchet the baseline with `cargo run -p butler-source-check -- --bless .`,
which never raises a count.

When the scan root contains `agent/src/lib.rs`, the checker also reads the production module tree
and enforces the reviewed domain dependency table, cross-domain facade access, and an acyclic
dependency graph. Test-only modules are excluded from that graph; their physical files still count
toward the size limit. Explicit crate/relative paths, grouped imports, and paths in macro tokens are
checked. Comments and string literals are not treated as imports. `include!` source fragments and
block-local module declarations fail because they obscure the declared module entry tree.

This syntax check complements compiler privacy and manual responsibility review. It does not
replace Rust name resolution, expand procedural macros, or resolve paths through every alias.
Module-file lookup follows the [Rust Reference](https://doc.rust-lang.org/reference/items/modules.html).
Update `tools/source-check/src/architecture/policy.rs` only after reviewing a domain or dependency
change. A passing checker does not establish runtime composition or performance acceptance.

Operating-system specific code belongs in `crates/butler-platform` only. Elsewhere the checker
flags `cfg(unix)`, `cfg(windows)`, `cfg(target_os)` and `cfg!` conditions, `std::os::*`, `nix`,
`libc`, `libproc` and `rustix` paths, octal permission literals, `HOME`/`USERPROFILE` reads and
OS-specific dependency tables in package manifests, tests included. Existing lines are ratcheted
per package in `os-specific-baseline.txt`; the counts may only shrink, and `--bless` records them.

The parser source notice is retained in [agent/THIRD_PARTY_NOTICES.md](agent/THIRD_PARTY_NOTICES.md). Final binary packaging must carry these notices; the current library checks do not prove distribution closure.

## User command hooks

Settings → Hooks manages `$BUTLER_DATA/hooks.json`. No hooks are installed by
default. Hooks run with your privileges and receive full prompt and tool content.
They cannot grant permission or change tool inputs. Project, plugin and HTTP
hooks are not supported yet.

```json
{
  "version": 1,
  "hooks": [{
    "id": "guard",
    "name": "Command guard",
    "event": "PreToolUse",
    "match": {"tools": ["run_command"]},
    "type": "command",
    "args": ["sh", "/absolute/path/guard.sh"],
    "timeout_ms": 30000,
    "failClosed": false,
    "enabled": true
  }]
}
```

Choose `command` (the platform login shell) or `args` (executable and literal
arguments). Optional `env` contains literal environment additions. Only the tool
environment allowlist is inherited; gateway tokens, provider credentials and
`BUTLER_DATA` are excluded. `${BUTLER_PROJECT_DIR}` in argv expands to the bound
project root. Working directory is the project root, otherwise your home.

Events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`
and `SubagentStop`. Tool matchers accept exact names or one trailing `*`.
The JSON stdin envelope uses `schema: "butler.hook.v1"`, `hook_event_name`, stable
`event_id`, timestamp, session/turn/parent identities, project/cwd, access mode,
and `hook: {id, scope: "user"}`. Session creation includes `source`; prompt
submission includes `prompt` and attachment name/media type/bytes. Tool events
include full `tool_input`, call id and `resumed`; post events include `ok`, full
`tool_response` and error details. Stop events include the full last answer and
`stop_hook_active` after a hook-requested continuation.

Exit 2 or `{"decision":"deny","reason":"..."}` denies a pre-event. `block` and
Claude Code's `hookSpecificOutput.permissionDecision: "deny"` are also accepted.
Exit 0 with empty/non-JSON stdout continues. Other exits, crashes, invalid JSON,
spawn failures, timeout and output overflow are logged and continue by default;
`failClosed: true` blocks on these failures. `allow` and `ask` are logged as
`approval_ignored`; normal permission checks still run. Input rewriting and
context injection are ignored. Reasons are limited to 16 KiB.

A tool denial becomes model feedback with code `hook_denied`. A Stop denial uses
the existing continuation budget. A rejected send returns `422 hook_blocked` and
keeps the composer draft. Observe events cannot block.

Sync timeout defaults to 30 seconds, capped at 120; observe-only `async: true`
defaults to 60 seconds, capped at 600. Matching sync handlers run concurrently,
then background handlers use a pool of eight. Identical handlers deduplicate.
Timeout and cancellation terminate the process tree, allow two seconds of grace,
then force termination and reap. Each output stream is capped at 64 KiB; overflow
is an error, never truncated success. Stdin is streamed in full.

Windows `command` uses `cmd.exe /d /s /c`. For PowerShell use
`args: ["pwsh", "-NoProfile", "-File", "C:\\path\\hook.ps1"]`. PowerShell 5
scripts should set `[Console]::InputEncoding = [System.Text.Encoding]::UTF8`.

The file is limited to 256 KiB, 64 hooks and 16 hooks per event. Invalid edits
retain the previous active registry and show an error in Settings. Butler checks
file metadata on session creation and send and reads only changed files; UI saves
publish immediately. There are no hook workers, timers or writes when disabled.
Recent runs are an in-memory ring of 200 entries, cleared on restart, with up to
4 KiB of each output stream for diagnostics. Test runs use a synthetic payload
and do not touch sessions. Configuration and tests require the local app's admin
credential. Saves reject stale revisions with 409.
