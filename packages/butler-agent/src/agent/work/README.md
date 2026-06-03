# agent work

`packages/butler-agent/src/agent/work/` owns durable work state. It stores direct worker tasks, planned
tasks, worker notifications, origin context, todo/checklist state, dashboard
projections, and role-aware work orchestration.

## Key Files

- `task-store.ts`: durable direct task records and recovery state.
- `planned-task.ts`: plan, attempt, review, repair, decision, and report state.
- `task-notifications.ts`: retryable worker completion notifications.
- `task-origin.ts`: origin context for topic continuity and recovery.
- `todo-list.ts`: checklist/todo persistence and validation.
- `work-dashboard.ts`: support-safe work projections.
- `work-orchestration.ts`: role-aware multi-stream work orchestration.

## Boundaries

Task state may reference private origins and transcripts, but user-facing
outputs must use safe summaries. Planned work should not be reportable until
review gates prove the result is ready.

## Durable Long-Running Work

Butler work must be durable across long-running sessions and worker lifetimes.
Interactive turns and background workers are expected to survive process
restarts, provider disconnects, app gateway retries, and work that spans 24
hours or more.

Success criteria:

- A provider disconnect, gateway retry, or runtime exception must not erase the
  active work state for a non-trivial Butler task.
- Interrupted direct work must leave a recoverable WorkStream with the latest
  public-safe phase, active step, todo list, and status note.
- Retrying or continuing a turn must never reopen a terminal WorkStream by
  mutating `complete` back to `executing`; terminal records are preserved and a
  new active stream revision is created when work resumes.
- Final delivery guards may block premature completion, but they must expose a
  resumable state instead of converting durable progress into an opaque
  `gateway_failed` outcome.
- Hard time and round budgets are safety boundaries only; hitting a boundary
  must checkpoint or recover work rather than silently losing progress.

## Related Specs

- `SPEC-AUTONOMOUS-PLANNED-DISPATCH` - Autonomous Planned Dispatch
- `SPEC-WORK-DASHBOARD` - Work Dashboard And Task Control Surface
- `SPEC-AGENTIC-CORE-TODO-LISTS` - Agentic Core AC-1 Todo Lists
- `SPEC-AGENTIC-CORE-WORK-ORCHESTRATION` - Agentic Core AC-7 Multi-Agent Work Orchestration
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
