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

## Related Specs

- `SPEC-AUTONOMOUS-PLANNED-DISPATCH` - Autonomous Planned Dispatch
- `SPEC-WORK-DASHBOARD` - Work Dashboard And Task Control Surface
- `SPEC-AGENTIC-CORE-TODO-LISTS` - Agentic Core AC-1 Todo Lists
- `SPEC-AGENTIC-CORE-WORK-ORCHESTRATION` - Agentic Core AC-7 Multi-Agent Work Orchestration
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
