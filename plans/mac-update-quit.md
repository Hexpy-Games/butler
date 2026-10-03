# macOS update / quit correction

Scope: `codex/mac-update-quit`, starting from `124e4dadf4a1eb69e66bd05f4b1915fc54783614`
(`origin/main` and `v0.1.0-preview.7`). Implementation, isolated validation and
branch publication only; no installed-app change, release, tag, merge or PR.

## Read-only diagnosis, 2026-10-03

Owner files were read without modifying config, services or installed bundles.
Both databases were opened with SQLite URI `mode=ro`. Only aggregate state and
safe installer messages are recorded here; no prompts, credentials or chat IDs.

- `/Applications/Butler.app/Contents/Resources/bundled-agent/native-agent-manifest.json`
  reported preview.6. `~/.butler/updates/staged/app.json` selected preview.7 from
  preview.6. This investigation compares that installation with the preview.7
  source, not a claim that preview.7 was already installed.
- `~/.butler/updates/app-install.log:1` and `:3`: `app-update-ready`.
  Lines `:2` and `:4`: `App update cancelled.` The native helper verified the
  candidate and then received closed activation input. No bundle swap follows
  that message.
- `~/.butler/app-server/butler-client.sqlite`: 1,247,989,760 bytes; 1,924 turns,
  all terminal (1,705 delivered, 146 cancelled, 73 failed). No queued/dispatching
  input. Retained queue history included one non-`turn_cancelled` failed input
  in an ordinary chat, which the old detector regarded as live work.
- `~/.butler/agent-runtime/btcc.sqlite`: approximately 7.1 GB. Two old Steward
  relations had `activity_terminal=0`, although their parent/child turns were
  delivered with completed disposition. They lacked a result record; display
  projection therefore reported `waiting`. Their creation dates were August 28
  and September 5. These were retained display states, not executing workers.

Original-source references below are **at tag v0.1.0-preview.7**, before this
branch's edits. Paths beginning `client/` are under `packages/butler-app/`;
Rust paths are under `packages/butler-agent/rust/crates/`.

| Question | Evidence and conclusion |
| --- | --- |
| Update-to-relaunch path | `client/electron/preload.cjs:696` stages through `/updates/apply`, then `:707` invokes `butler:open-update-artifact`. `client/electron/main.mjs:2589` prepares the helper, `:2596` runs the quit workflow, `:2597` activates the helper and `:2599` quits. `client/electron/app-package-update.mjs:10` revalidates staging/checksum; `:32` spawns the native installer with the exact parent PID and activation pipe. |
| Bundle replacement | `butler-platform/src/app_update.rs:102` publishes ready, `:103` waits for activation, `:104` waits for the exact parent to exit, `:106` backs up the installed bundle, `:107` swaps the candidate, `:111` launches the replacement executable. Spawn failure restores the previous bundle. All OS-specific installation remains in butler-platform. |
| Quit warning owner | `client/electron/main.mjs:2364` directly calls the generic `confirmAppForegroundQuit` for updates. Plain `before-quit` also calls it at `:2691`. The update's first warning is therefore a direct reuse of quit confirmation, rather than a later before-quit veto. `client/electron/app-foreground-quit.mjs:71` creates the warning. |
| What was counted | `client/electron/main.mjs:2749` loads navigation, worker activity and every ordinary chat's queue. `client/electron/app-foreground-quit.mjs:28` counts nonterminal navigation turns; `:43` counts nonterminal worker display states, including `waiting`; `:52` counts any queue item. `butler-gateway/src/gateway/application/queue_view.rs:34` intentionally includes retained failed input. The detector confuses that display/retry history with running work. |
| Ghost delegated state | `butler-turn/src/btcc/storage/subsessions/activity.rs:78` derives display status from a result; without a result only admitted turns are active and everything else falls through to waiting at `:84`. Thus a delivered child with an old open activity flag still looks waiting to the old quit detector. |
| Background jobs / approvals / schedules | Original `/worker-activity` is delegated user-session activity, not the embedding/indexing or memory maintenance registry. Those internal jobs were not demonstrated as the cause. Idle schedule configuration is not counted, despite the warning mentioning schedules. Navigation counts active visible chat turns, including suspended turn states, but its ordinary-chat list misses other chat kinds. There is no separate open-approval inventory in the detector. |
| Both buttons abandon update | `client/electron/app-foreground-update.mjs:48` returns cancelled for Cancel. Quit proceeds through `client/electron/main.mjs:2382` with `requireSettledDrain`; `client/electron/app-foreground-drain.mjs:18` cancels turns/workers, then polls up to 25 times at 200ms (`:25`). Retained failed input cannot settle through cancellation, so the snapshot remains nonzero and returns deadline exceeded. `client/electron/main.mjs:2605` closes the helper pipe for either non-start result. `butler-platform/src/app_update.rs:283` rejects the closed activation pipe with the observed installer message. |
| Why the button simply returns | `client/electron/preload.cjs:707` awaits activation but discards its returned failure/cancellation status and returns the staged result at `:711`. Settings clears its applying state. Quit bypass flags at `client/electron/main.mjs:2395` would have been set on success; evidence points to failure before activation, not a lost relaunch flag. |

The log does not identify which dialog choice the owner selected in each attempt.
The code and retained failed input explain both possible abort paths. No captured
caller stack identifies the source of the owner's other, apparently spontaneous
quit requests. Menu/UI quit, `SIGINT` and `SIGTERM` can enter the same handler
(`client/electron/main.mjs:2773`); the false-positive warning is explained, but
the initiating signal/caller remains unverified.

## Implemented contract

- One update coordinator owns request identity, the update choice, deferred work
  observation, helper activation and failure state. Update restarts set quit
  bypass after native shutdown and before activation. They never call generic
  quit confirmation or cancellation-drain APIs.
- With no user work, prepare/checkpoint/activate/quit proceeds without a dialog.
  With work, one DS Dialog offers `작업이 끝나면 업데이트` / `지금 업데이트`.
  Escape chooses deferral; outside clicks do not dismiss the decision.
- Now preserves the native shutdown contract: stop admission before interrupting
  active turns; persist interrupted work as failed, `turn_interrupted`, retryable;
  leave queued follow-ups durable and resume them after executor readiness. The
  active model request is not silently replayed. Original input/partial output
  survives and can be retried. Native order:
  `butler-agent/src/host/service/entrypoint/support.rs:124`;
  interruption: `butler-agent/src/host/service/ingress/dispatch/interrupted.rs:71`.
- Defer remains visible in Settings with a disabled action and brief status.
  Authenticated `/events/live` wakes a debounced indexed `/user-work` read.
  Subscription happens before rereading; completion during the choice cannot
  strand the update. New work during helper preparation cancels that preparation
  and continues waiting. No idle polling scans are introduced.
- A real native SSE smoke exposed a second completion hazard in this sandbox:
  BTCC had delivered the first turn, but App still showed it thinking and left
  both follow-ups queued until an explicit `/turns` read refreshed projection
  (`butler-gateway/src/gateway/http/read_routes.rs:82`). File notification did
  not deliver completion; its underlying OS cause is not established. Successful
  transcript appends now notify the existing projection owner directly
  (`butler-gateway/src/gateway/transcript.rs:48`,
  `butler-gateway/src/gateway/application/projection/owner.rs:127`). The host
  connects the current App generation at `butler-agent/src/host/app/server.rs:315`.
  This reuses bounded/deduplicated notification processing, keeps external file
  watching and recovery, and uses a weak owner reference to avoid a lifetime cycle.
- `/user-work` counts live turns across all chat kinds, pending/unclaimed input,
  and actual admitted/delivery-pending delegated execution or pending dispatch.
  Failed queues, runtime-fault history and delivered ghost children are excluded.
  Form/tool waiting turns represent user work, including pending approvals.
  Executing scheduled turns count; idle schedules, memory maintenance, embedding
  and indexing have no role in this predicate. Display/retry history is retained.
- Activation outcomes reach preload/UI. Failed verification/checkpoint/application
  requests show the existing translated update error. Deferred/preparing/restarting
  state survives Settings remounts. KO/EN copy uses i18n keys, and the dialog uses
  DS exports only. DS components and primitives are unchanged.

## Validation and handoff

All checks/tests use fresh temporary HOME/BUTLER_DATA, stub/replay model traffic,
private ports and owned-PID cleanup. The owner installation was never stopped.

- Rust E2Es passed: `queue_shutdown` (1), `shutdown_order` (6), `shutdown_wal`
  (2), `subsession_legacy` (2), `update_channels` (2), `updates` (1), `user_work`
  (1), `streaming` (2), `projection_backlog` (3): **20 tests**. Existing
  `queue_admission_shutdown` also passed (1). Existing gateway projection tests
  passed (8).
  The real active-turn/full-queue restart test retains original recovery and
  message-completeness assertions.
- Focused Bun tests: **15 passed, 57 assertions**, including exact choice identity,
  single activation, both deferral races, checkpoint failure feedback and exclusion
  of failed/background history. Unit count decreases; category tags are present.
- `bun install --frozen-lockfile --ignore-scripts`, `bun run check`, UI build,
  `cargo fmt`, touched-crate clippy `-D warnings` and source-check passed.
  A final run initially hit a shared sccache daemon's deleted temp path; disabling
  the wrapper for these processes resolved that build-environment failure.
  Source-check's function ratchet caught the added connection in an existing
  long function; extracting App construction reduced it from 143 to 132 lines.
  The baseline was lowered with `--bless`, then normal source-check passed:
  2,195 Rust files; function/platform/test/architecture violations all zero.
- Owner-scale fixture: 600 chats, 300,000 terminal turns and retained failed input;
  complete `/user-work` result took **753.292 microseconds**. The normal E2E job
  records budgets without enforcing them; the dedicated single-thread perf run
  passed in **1.005459ms** with the unchanged 1s budget enforced.
- Read-only owner query measurement: App counts `(0,0)` in **0.358ms**; delegated
  presence false in **2.989ms**. EXPLAIN used `turns_state_rowid_idx`,
  `session_queued_messages_active_idx`, the partial `idx_btcc_activity_open_page`,
  `idx_btcc_turns_session` and the relation identity index. These are individual
  read measurements, not an end-to-end Electron latency benchmark.

Electron `--single-process --version` aborted with exit 134 before app startup.
Playwright full Chromium also aborted during launch with `--single-process`;
no UI assertions ran. Real bundle swap/relaunch and visual acceptance are therefore
**host-pending**, not passed. Run from this branch on the coordinator's host:

```sh
tests/smoke/mac-update-quit-host.sh
```

The host script prepares private data/builds and runs KO/EN DS dialog choices at
320/375/390/430/1440px, then signed fixture preview.90 → preview.91 with a stub
update feed/provider in four modes: idle (no decision), now (active input retryable,
two follow-ups delivered), defer (all three delivered before automatic update),
background-only quit (real held memory bootstrap plus future schedule, no warning).
It checks the new app/agent version, checksum, signature, bundle structure, healthy
Agent and preserved data/chat. `BUTLER_SMOKE_BROWSER_ARGS='["--single-process"]'`
uses the existing shared smoke argument helper when that host requires it.
The Windows cancellation smoke's coordinator API was updated and typechecked;
its Windows execution (`packages/butler-app/scripts/windows/active-work-cancellation-smoke.ts:1`)
was not run on this macOS host.

`tests/smoke/app-update-work-stream.ts` **passed** against the actual native Agent:
background-only quit did not prompt; one held active turn and two queued inputs
all delivered, then authenticated SSE triggered deferred activation exactly once
after native shutdown. It performs no `/turns` refresh while awaiting settlement.
Publication status is recorded at delivery; no PR will be opened.

## Publication limitation

`git ls-remote origin refs/heads/main` confirmed main is still
`124e4dadf4a1eb69e66bd05f4b1915fc54783614`. `git fetch origin` was denied writing
the worktree's shared `FETCH_HEAD`. Final staging and the requested normal commit
were also denied creating shared `index.lock`, before any hook ran. No
`--no-verify` bypass was used. No new commit or push could be completed.

Branch: `codex/mac-update-quit`; current HEAD remains the starting commit above.
The runner must stage **both staged and unstaged changes**, commit and push this
branch. Do not open a PR, tag or merge. All implementation and delivery files
remain in this worktree; the build target is removed after checks finish.
