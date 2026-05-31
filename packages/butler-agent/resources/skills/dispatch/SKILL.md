---
name: dispatch
description: Dispatch a task to a native worker process. Results arrive automatically when done.
user-invocable: true
applicability: Use when the model decides the request should leave the current turn for a native worker, planned task, review-heavy implementation, or long-running investigation.
allowed-tools: dispatch_worker, create_planned_task, run_planned_task, review_planned_task, repair_planned_task, write_planned_public_report, request_principal_decision
dispatch: auto
review: recommended
reporting: Send a concise plan before long work, then report reviewed outcome only.
---

## Instructions

Dispatch a task to a native worker.

**Usage:**
The user provides a task description and optionally a project path and model.

- project_path: defaults to $BUTLER_HOME if not specified
- model: defaults to the configured worker model
- Results are delivered automatically when the worker completes
- Multiple dispatches can run in parallel

**For the caller (butler/steward):**
Use Butler's native worker dispatch path. Do not block the active session while waiting for worker completion.

Choose the path autonomously:

- Use direct dispatch for simple, bounded work where a separate review cycle is not needed.
- Use planned dispatch for coding, research, migration, multi-step investigation,
  risky changes, or anything that needs explicit acceptance criteria and review.
- Do not ask the user to approve the plan unless there is a critical decision
  with meaningful tradeoffs. In that case, prepare a recommendation and
  concrete options.
- For planned dispatch, create the durable plan first with goal, acceptance
  criteria, verification commands, risk notes, repair policy, and public report
  policy. Execution happens after plan creation.

**Reading the result:**
The background task output contains the worker's result directly. When notified of completion, read the output file to get the result.
