# Quit feedback and profiling

Normal Quit (menu, Cmd+Q, tray, IPC and Windows window close) now hides the main
window synchronously, shows a preloaded 380×132 static lifecycle window, and
closes the App-owned Agent's stdin lease. There is no app bundle or preload in
the lifecycle window. Its mark is generated from the Site DS idle mark; its
tokens are a dependency-closed projection of the UI DS tokens. Verify provenance
with `node scripts/sync-lifecycle-assets.mjs --check`.

The previous normal-Quit path kept the main window visible while fetching
navigation, worker activity, and every chat's queue for confirmation, followed
by UI cancellation and up to 25 full snapshots with 24×200 ms sleeps (4.8 s
plus request time). At 600 chats, that drain alone can send 15,050 requests.
User cancellation also has different queue-pause semantics from service
interruption. Normal Quit now delegates interruption and durable FIFO settlement
to the existing service owner. Update-install confirmation/drain remains separate.

The Agent stops admission before draining active turn futures and settling their
queue claims. Queued follow-ups stay durable and unpaused. An interrupted active
input remains retryable; it is not silently rerun. App Quit uses portable stdin
EOF instead of Windows `child.kill()`. The six-second App shutdown budget changes
feedback to an explicit delay message and keeps waiting. Neither the App's eight
second kill timer nor the Agent's forced six-second cleanup runs for this path.
Other controllers retain their existing deadlines and tests.

Control connection joins run alongside turn drain after admission closes. The
three independent canonical SQLite owners close concurrently after all producers
join. WAL retention and publication/close ordering remain unchanged. No database,
transcript or metrics scan was added to Quit.

## Host Electron proof

The sandbox's Electron executable aborts with SIGABRT even with
`BUTLER_SMOKE_BROWSER_ARGS='["--single-process"]'`. Native window hide/show timings
and actual Electron process-exit improvement are **unavailable here**.

From this checkout on the coordinator's host, with the built Agent selected:

```sh
task_tmp=$(mktemp -d "${TMPDIR:-/tmp}/butler-quit-host.XXXXXX")
export HOME="$task_tmp/home" BUTLER_DATA="$task_tmp/data"
mkdir -p "$HOME" "$BUTLER_DATA"
export BUTLER_NATIVE_AGENT_EXECUTABLE="$PWD/target/debug/butler-agent"
bun run tests/smoke/app-quit-feedback.ts
bun run tests/smoke/app-quit-feedback.ts --blocked
python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$task_tmp"
```

Build UI with `bun run app:ui:build`, and Agent with `cargo build -p butler-agent`
in `packages/butler-agent/rust`, each with fresh temp HOME/BUTLER_DATA. If Electron
was installed with scripts disabled, run its `install.js` first, also isolated.
The smoke itself creates and cleans another isolated installation, data and
Electron profile, uses a local streaming model stub, and prints structured timing
records plus per-native-phase durations and current source locations. It asserts
main hide **and** feedback show within 200 ms, clean exit, retryable interrupted
input, two persisted user inputs, exactly one delivered follow-up, and unpaused
queue after a new Electron process starts. `--blocked` holds BTCC storage for seven
seconds and also checks the actual delay message before releasing the lock.

For a paired baseline, build origin/main separately and run this checkout's smoke
against that Electron directory and binary:

```sh
BUTLER_QUIT_ELECTRON_ROOT=/absolute/baseline/packages/butler-app/client/electron \
BUTLER_NATIVE_AGENT_EXECUTABLE=/absolute/baseline/target/debug/butler-agent \
bun run tests/smoke/app-quit-feedback.ts --baseline
```

Baseline mode retains the same post-restart durability assertions; it reports
the original main-window closure time instead of asserting new feedback exists.
Do not combine baseline mode with `--blocked`.

## Phase ownership

Native traces use monotonic elapsed timestamps and wall timestamps to correlate
the Agent and gateway lanes. `tests/smoke/quit-phase-report.ts <log>` reports each
measured interval with a current `file:line`, including nested parallel phases.
Nested intervals must not be added together as a total.

| Step | Measurement / owner |
| --- | --- |
| Main hide / lifecycle show | Electron smoke native hide/show events; `main.mjs`, `quit-feedback.mjs` |
| Admission, LAN listeners and live streams | `app_admission`; `host/service/entrypoint/support.rs`, `host/app/server.rs`, `gateway/server.rs` |
| Maintenance, parent publication | `maintenance_join`, `progress_reconcile`; `host/service/entrypoint/poll.rs`, `support.rs` |
| Active turn and full queue settlement | `turn_drain`; `host/service/ingress.rs`, `ingress/shutdown.rs` |
| Control/tunnel-facing endpoint lifecycle | `control_close`, `app_endpoint_persist`; `host/app/gateway_lifecycle` (no separate tunnel child on the default foreground path) |
| Update hooks | `app_close` includes `AppApplication::cancel_updates`; `gateway/application.rs` (normal Quit starts no install helper) |
| App projection/file owners/DB | `app_*_join`, `app_dispatcher`; `gateway/application.rs`, `host/app/server.rs` |
| Embedding acquisition / worker | `embedding_acquisition`, `runtime_embedding`; `host/runtime/contracts.rs`, `owners.rs` |
| Other runtime owners | `runtime_*`; `host/runtime/owners.rs` |
| Canonical DB/WAL close | `conversations_store`, `bindings_store`, `btcc_store`; `host/runtime/stores.rs` |
| Transcript flush | `transcript_close`; `host/service/entrypoint.rs` |
| Instance record/fsync/release | `instance_*`; `host/service/instance/record.rs`, `instance.rs` |
| Port release / renderer teardown / OS exit | Remaining Electron quit-to-exit interval; `main.mjs`, native Electron close events |
| Developer logs | Written and closed per append in `butler-runtime/.../developer_log/store.rs`; no independent deferred log-flush step |

The static lifecycle surface overlaps `codex/startup-splash`: share
`lifecycle-window.mjs`, DS asset generation and native security settings when
merging. Quit status/timeout ownership remains in `quit-feedback.mjs`.

## Local validation

The exact desktop timing and owner-sized production-data run remain host work;
no owner data was read. The WAL E2Es assert all rows, values, ranges and schedule
state after restart; they exercise 192 MiB across the three runtime stores and a
64 MiB App WAL, rather than claiming a 1.3 GB App / 7 GB BTCC production run.


### Measured native shutdown on this Mac

One paired stub run, unmodified Agent versus current Agent, with an active
stream and queued follow-up. This measures the native stop, **not Electron Quit**.
The process-exit observation was **214.725 ms before / 159.052 ms after** (50 ms
harness polling granularity). Restart plus recovered follow-up was 7.614 s /
4.719 s; it includes startup and model playback, so it is not a quit-latency metric.
The independent earlier baseline was 104.579 ms; these samples do not establish
statistical latency improvement. Both paired runs asserted complete recovery.

Below are all measured intervals from the paired shutdown. A is
packages/butler-agent/rust/crates/butler-agent/src; G is the sibling
butler-gateway/src. Locations refer to this checkout. Reused trace names list
both call sites. Nested intervals overlap; neither rows nor parallel store times
should be summed. New instrumentation has no baseline measurement.

| Native phase | Before ms | After ms | Current file:line |
| --- | ---: | ---: | --- |
| maintenance_join | 0.251 | 0.068 | A/host/service/entrypoint/poll.rs:112<br>A/host/service/entrypoint/poll.rs:117 |
| app_admission (1) | 0.214 | 0.089 | A/host/service/entrypoint/support.rs:124<br>A/host/app/server.rs:292 |
| control_close | 0.031 | 0.035 | A/host/service/entrypoint/support.rs:128 |
| turn_drain | 41.776 | 34.309 | A/host/service/entrypoint/support.rs:127 |
| progress_reconcile | 0.492 | 0.209 | A/host/service/entrypoint/support.rs:134 |
| app_admission (2) | 20.617 | 10.624 | A/host/service/entrypoint/support.rs:124<br>A/host/app/server.rs:292 |
| app_setup_join | 0.081 | 0.053 | A/host/app/server.rs:294 |
| app_project_dashboard_briefing_join | 0.042 | 0.015 | G/gateway/application.rs:365 |
| app_dispatcher | 0.020 | 0.015 | G/gateway/application.rs:370 |
| app_transcript_exports_join | 0.009 | 0.036 | G/gateway/application.rs:371 |
| app_queue_mutations_join | 0.014 | 0.013 | G/gateway/application.rs:376 |
| app_session_creation_join | 0.011 | 0.010 | G/gateway/application.rs:377 |
| app_project_creation_join | 0.010 | 0.008 | G/gateway/application.rs:378 |
| app_session_branches_join | 0.009 | 0.008 | G/gateway/application.rs:379 |
| app_space_mutations_join | 0.044 | 0.042 | G/gateway/application.rs:380 |
| app_wallpapers_join | 0.801 | 0.539 | G/gateway/application.rs:381 |
| app_projection_join | 0.899 | 0.355 | G/gateway/application.rs:382 |
| app_retention_join | 1.057 | 0.061 | G/gateway/application.rs:384 |
| app_sqlite_wal_fsync | 7.595 | 8.179 | G/gateway/application/storage/tuning.rs:74 |
| app_sqlite_directory_fsync | 6.849 | 6.500 | G/gateway/application/storage/tuning.rs:84 |
| app_sqlite_connection_close | 0.707 | 0.469 | G/gateway/application/storage.rs:271 |
| app_storage_join | 15.673 | 15.488 | G/gateway/application.rs:387 |
| app_artifacts_join | 0.017 | 0.016 | A/host/app/server.rs:296 |
| instance_file_fsync | 5.291 | 5.047 | A/host/service/instance/record.rs:74 |
| instance_file_rename | 0.424 | 0.399 | A/host/service/instance/record.rs:81 |
| instance_write | 6.571 | 6.235 | A/host/service/instance/record.rs:44 |
| app_endpoint_persist | 7.348 | 6.573 | A/host/app/gateway_lifecycle/owner.rs:248 |
| app_close | 48.000 | 34.636 | A/host/service/entrypoint/support.rs:137 |
| embedding_acquisition | unavailable | 0.029 | A/host/runtime/contracts.rs:58 |
| runtime_context_maintenance | 0.224 | 0.064 | A/host/runtime/owners.rs:37 |
| runtime_project_tools | 0.031 | 0.030 | A/host/runtime/owners.rs:42 |
| runtime_project_work | 0.029 | 0.012 | A/host/runtime/owners.rs:43 |
| runtime_session_worktrees | 0.013 | 0.014 | A/host/runtime/owners.rs:44 |
| runtime_image_files | 0.012 | 0.017 | A/host/runtime/owners.rs:45 |
| runtime_attachment_context | 0.023 | 0.009 | A/host/runtime/owners.rs:51 |
| runtime_memory_sync | 0.298 | 0.189 | A/host/runtime/owners.rs:57 |
| runtime_embedding | 0.145 | 0.129 | A/host/runtime/owners.rs:58 |
| runtime_profile | 0.011 | 0.011 | A/host/runtime/owners.rs:61 |
| runtime_cognition | 0.013 | 0.010 | A/host/runtime/owners.rs:62 |
| runtime_memory_recall | 0.010 | 0.009 | A/host/runtime/owners.rs:63 |
| runtime_conversation_tools | 0.009 | 0.008 | A/host/runtime/owners.rs:64 |
| runtime_memory_query | 0.010 | 0.008 | A/host/runtime/owners.rs:70 |
| runtime_conversation_reference | 0.009 | 0.009 | A/host/runtime/owners.rs:73 |
| runtime_plans | 0.027 | 0.078 | A/host/runtime/owners.rs:79 |
| runtime_command | 0.041 | 0.022 | A/host/runtime/owners.rs:80 |
| runtime_commands | 0.054 | 0.013 | A/host/runtime/owners.rs:81 |
| runtime_tool_output | 0.058 | 0.038 | A/host/runtime/owners.rs:82 |
| runtime_files | 0.884 | 0.011 | A/host/runtime/owners.rs:83 |
| runtime_mutations | 0.230 | 0.010 | A/host/runtime/owners.rs:84 |
| runtime_skills | 0.056 | 0.012 | A/host/runtime/owners.rs:85 |
| runtime_work_streams | 1.584 | 0.096 | A/host/runtime/owners.rs:86 |
| runtime_observer | 1.115 | 0.060 | A/host/runtime/owners.rs:87 |
| conversations_store | unavailable | 10.672 | A/host/runtime/stores.rs:87 |
| bindings_store | unavailable | 14.745 | A/host/runtime/stores.rs:88 |
| btcc_store | unavailable | 19.960 | A/host/runtime/stores.rs:89 |
| runtime_stores | 38.355 | 20.089 | A/host/runtime/owners.rs:90 |
| runtime_close | 73.139 | 53.182 | A/host/service/entrypoint.rs:202 |
| transcript_close | 0.326 | 0.177 | A/host/service/entrypoint.rs:203 |

Desktop hide/show, renderer teardown and OS process-exit tail are unavailable
because Electron cannot launch here. Their owning locations are main.mjs:2699
(Quit entry), quit-feedback.mjs:18 (hide/show), main.mjs:2833 (Agent exit),
main.mjs:2849 (port release), and main.mjs:2145 (renderer window close).
Update hooks are inside gateway/application.rs:363 (the measured app_close);
no helper is launched on ordinary Quit. LAN listener close is inside
gateway/server.rs:75 (measured admission). The default foreground path has no
separate tunnel child. Developer logs close each append at
butler-runtime/src/operations/developer_log/store.rs:69, so there is no pending
process-wide log flush to time independently.

Validation: isolated bun install --frozen-lockfile --ignore-scripts, UI build,
bun run check, 37 focused existing shell tests, static KO/EN window smoke,
DS asset provenance check, Rust fmt, clippy -D warnings on Agent/Gateway/E2E,
source-check (zero violations), and 11 shutdown E2Es passed. The six-second
blocked-storage safe-quit test recovered the full queue (6.126 s); the WAL tests
retained 73,533,792 App-WAL bytes and checked 24,576 complete runtime rows.
Electron smoke is supplied but unverified on a host; Windows desktop behavior is
also unverified here. No PR, merge or tag was created.


The existing shutdown-order E2Es also passed with BUTLER_E2E_PERF=1 and one test
thread: control reads 54.0/53.2 ms within 2 s, active stream 115.5 ms within 8 s,
hung MCP 2.058 s within 8 s, record-write races 6.098/7.069 s within 8 s, and
blocked-storage CLI stop 6.036 s within 8 s. These are enforced budgets, not
only descriptive measurements. Initial compiler-cache and working-directory
issues were corrected; no tests or budgets were weakened.

Shared Git metadata writes are denied in this sandbox: fetch could not write
FETCH_HEAD, and add could not create index.lock. The remote main was verified
read-only as 124e4dadf4a1eb69e66bd05f4b1915fc54783614, matching this checkout's
base. Changes remain for the runner to commit and push on codex/quit-feedback;
no new commit or remote publication was possible here.
