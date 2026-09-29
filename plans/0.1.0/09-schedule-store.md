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
