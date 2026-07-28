---
name: butler-ship-feature
description: "Use for Butler project feature work, migrations, fixes, specs, experimental spikes, reviews, or roadmap execution when Codex must follow the Butler ship-feature loop: spec first, task plan, tests, implementation, internal review, docs/report, validation, and phase commit."
user-invocable: false
applicability: Use when Butler project work requires the ship-feature loop: spec, task plan, implementation, tests, review, report, validation, and commit.
allowed-tools: project-ledger-cli, run_command
dispatch: none
review: required
reporting: Report spec criteria, tests, validation gates, review findings, residual risk, and commit state before phase completion.
---

# Butler Ship Feature

## Core Rule

Run Butler work through this loop:

1. Update or create the governing spec first.
2. Break the execution plan into task-sized slices.
3. Write tests from the spec before or alongside implementation.
4. Implement the smallest vertical slice that satisfies the spec.
5. Review the result against the spec.
6. Run validation gates.
7. Update docs, reports, and handoff/progress notes.
8. Commit each completed phase.

Do not report 100% completion unless the spec success criteria, tests, review,
docs, and validation gates are all closed.

## Spec Discipline

- Treat the spec as the source of truth, not the plan.
- If behavior is undefined, update the spec before coding.
- Every feature must have success criteria that map to unit, integration,
  or E2E tests.
- Plans may describe order and scope, but they must not replace the spec.

## Implementation Workflow

Use this sequence for each phase:

1. **Context**: Read the active spec, plan, relevant code, recent reports, and
   current git status.
2. **Plan**: Keep a short task plan with exactly one active task.
3. **Tests**: Add or update tests that would fail without the intended behavior.
4. **Code**: Implement without reverting unrelated user changes.
5. **Internal review**: Compare the diff against the spec success criteria.
6. **Validate**: Run targeted tests, `bun run check`, and `git diff --check`
   unless the phase has a narrower justified gate.
7. **Docs/report**: Update the governing spec if behavior changed, then update
   plan/report/handoff-style progress docs.
8. **Commit**: Commit the completed phase with a concise message.

## Validation Gates

For Butler repo work, prefer these gates:

```bash
bun test <targeted tests>
bun run lint
bun run typecheck
git diff --check
bun run check
```

Add feature-specific gates when relevant:

- transport work: transport-agnostic harness tests
- memory work: stress reports, vector and graph count checks
- installer work: install/repair smoke tests
- runtime work: BTCC product-cutover and mock transport tests

If a gate cannot run, record why and what risk remains.

## Reporting

Keep final reports concise but include:

- what changed
- which spec criteria are now covered
- test and validation results
- remaining risks or next phase
- commit hash when committed

Avoid dumping raw personal memory, transcripts, credentials, or private runtime
data into reports.
