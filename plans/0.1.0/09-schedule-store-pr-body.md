Closes #269. Implements [plan 09](09-schedule-store.md).

| Path | Store before this change | Record schema before this change |
| --- | --- | --- |
| `butler-gateway/src/gateway/http/automations.rs` and `application/automations/{store,records,dispatch}.rs` | App SQLite `app_automations`, `app_automation_runs` | Schedule: id, title, prompt_body, target kind/session, interval_seconds, access_mode, state, next/last run, run status/error/counts, timestamps. Run: id, schedule/session, state/trigger, timestamps, error, queued message and turn IDs. |
| `butler-agent/src/host/cli/schedule.rs` | `DATA/automations/*.json` through `AutomationCliStore` | JSON v1: id, title, prompt, session_id, status, `schedule` (`once.run_at` or `interval.interval_minutes/start_at`), next/last run, run_count, timestamps. |
| `butler-agent/src/host/guided/tools/effect/automation.rs` | Same JSON files through `AutomationService` | Same JSON v1 record; `create_automation`, `list_automations`, `delete_automation`, `run_due_automations`. |
| `butler-runtime/src/operations/automation/{actor,store,records}.rs` (removed) | Same JSON files | Same JSON v1 record; claimed run was a transient envelope, not a durable run row. |
| `butler-gateway/src/gateway/application/automations/scheduler.rs` | App DB | 30-second poll of due schedules and queued runs. |
| `butler-runtime/src/operations/automation/actor.rs` (removed) | JSON files | 60-second whole-directory/record scan. |

The App DB is the sole schedule and run store. Its schedule row adds `schedule_type`, `run_at`, `start_at` and `legacy_record_json` so one-shot timing and every imported source field survive. The startup transaction imports JSON records once under `schedule_json_import_v1`, retains the source files, and logs the count. Imported access follows the target conversation's resolved mode. Unresolved legacy targets are retained but paused, with their original target in `legacy_record_json`.

API, CLI and chat tools now use the gateway's typed App schedule service. The gateway scheduler sleeps until the next due time and wakes on schedule changes and queued-run turn completion. The queued-run partial index is `app_automation_runs_queued_idx`.
