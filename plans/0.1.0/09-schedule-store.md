# 09. One schedule store (#269, P1, before 10)

**Start from:** `origin/main`. Issue #269 has the decision and the work breakdown.

## Steps
1. Map every schedule store and code path, and write the result in the PR body as a table (path, store, record schema). Include:
   - the gateway `/automations` (`butler-gateway/.../automations/*`, App DB `app_automations`, `app_automation_runs`);
   - the CLI `butler schedule`;
   - the model-facing schedule tools (`butler-agent/src/host/guided/tools/effect/automation.rs`, plus the runtime operations automation actor at `butler-runtime/src/operations/automation/*`);
   - the scheduler runtime(s).
2. Choose one canonical store and one record type. Prefer the gateway App DB, since it already carries `access_mode` (#237) and the #262 naming. Put all create, list, update, delete and run paths behind a single typed schedule service.
3. Migrate every record from the other stores into the canonical one:
   - once and idempotently, guarded by a marker;
   - without losing fields;
   - following the #262 access-mode migration rules.
   Keep the old files as they are, and log that they were migrated.
4. Keep exactly one scheduler loop.
   - Today the gateway scheduler polls every 30 s and the automation actor re-reads its JSON every 60 s.
   - Make the loop sleep until the next due time. No polling.
   - Add a partial index for queued runs (plan 07).

## Acceptance
E2E:
- A schedule created through the API, the CLI or a chat tool call appears in all three, and can be edited from any of them.
- The migration moves legacy records exactly once.
- A run uses the schedule's own `access_mode`.
- While idle, the scheduler performs no reads until the next due time.

## Preview.6 ordinary-chat correction (2026-10-03)

Authority: the schedule-delegation task; inherited schedule-create commit
`85d866382206` and approved `origin/codex/work-model-design`, §2.6 (Tier 0
single-step actions). This correction changes routing/capability recovery only;
it does not implement the complete Work-model storage or tier migration.

Read-only owner evidence (KST = UTC + 9), quoted minimally:

| Cause | Real trace | Corroboration and correction |
|---|---|---|
| Capability unavailable | `~/.butler/transcripts/steward-309949e0f58fa018f3fa19d55fbcf017.jsonl:61`, `:77`, 12:48:56–12:49:03 | The matching `btcc_guided_tool_calls` rows in read-only `agent-runtime/btcc.sqlite` returned `create_automation enabled:false`, outside the scoped progressive surface. The inherited schedule-create change admits discoverable parent CRUD in ordinary chats without always offering those schemas; the effect guard and ask-first authority remain in control. A child receives only its admitted grant. |
| Incorrect delegation | `~/.butler/transcripts/butler_app-general.jsonl:12569`, 12:48:27 | `delegate_to_steward` queued the schedule registration. Its canonical request confirmed daily 07:00 Asia/Seoul in the current chat. Registering a future research prompt is a single direct action; performing that research later is a separate workload. The existing semantic router and delegation tool now state this Tier 0 boundary. |
| Prose hand-back ended the job | child transcript above `:141`, 12:49:45; parent transcript `:12589`, `:12817`, 12:50:16–12:50:29 | Child disposition was blocked for missing creation/update tools; its result had no typed recovery code. Parent closed its Work and reported only that registration remained undone. The new blocked `capability_handoff` contains the exact tool/action arguments, persists through the existing next-condition/result/outbox owners, and carries `capability_unavailable_in_child`. Parent closeout requires a successful matching operation or an explicit approval denial in that same result Turn. |

Owner data was read only (`mode=ro`, `immutable=1`); no live service, schedule,
profile, credential, or installation was modified. This evidence concerns the
matched recorded turns, not every later uncheckpointed WAL entry.

Acceptance: `schedule_chat` proves discovery, exact persisted 07:00 KST state,
approval before creation/pause/delete, and zero child delegations. Its synthetic
cassette is a deterministic wire replay, not a live-model routing measurement.
`schedule_handoff` proves an unavailable child schema, typed result/outbox,
rejection of prose-only parent closeout, approved creation in that same parent
result Turn, one owner message and one schedule effect. Restart coverage retains
legacy result codes, direction revisions and activity-trigger references without replaying the effect.
The parent static prefix + changed schemas ratchet uses o200k token counts from
`85d866382206`: local legacy 3067, ledger legacy 3130, phase read-only 1258,
phase execution 1328 (direct prefix alone 182). No baseline is raised.

Open product question, deliberately unimplemented: does “deliver at 07:00” mean
starting research earlier with a configurable/adaptive lead time? Define how to
estimate duration, handle overruns and source freshness, and distinguish the
research start time from the delivery target. Current `start_at` is execution
start, so completion can occur after 07:00.
