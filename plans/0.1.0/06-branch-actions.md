# 06. Branch actions in project sessions and the steward pill (#316, P1)

**Start from:** #316 (`claude/steward-controls-pill`). The PR body has the review checklist.

## Context
- **Owner-reported symptom:** assistant messages in project sessions lost two actions, "새 주제 대화 시작" (start a new topic chat) and "새 프로젝트 시작" (start a new project). Only the copy button is left.
- **Root cause:** the native gateway never ported `POST /space/branches`. It returned 404 everywhere. #316 ports it and shows the actions in project sessions too.
- **Steward pill:** it disappeared while a steward was streaming, because `active_turn` is null during streaming. #316 fixes that as well.

## Remaining review fixes
1. **Smoke test flake** in `tests/smoke/app-branch-actions-smoke.ts:47-54`. The test clicks the project header without waiting, which collapses a project that is already expanded. Wait for the project row, click it only when `aria-expanded="false"`, then click the session row and wait for the assistant footer.
2. **Steward results leak into the branch seed** on the canonical path (`butler-agent/src/host/app/runtime_ports/topic_branch.rs:133-150`). Steward-result user messages have visibility `Model` (`butler-turn/src/conversation/messages.rs:103`). Exclude them, matching the owner_visible filter from #299. Better, mark them non-owner-visible at write time.
3. **Client performance:** `AssistantBranchActions.tsx:13-15` runs `activeProjectId`, which scans all projects, in a store selector for every assistant message on every store update. Resolve it once per transcript, or use the session's own `project_id`.
4. **Rust E2E for `POST /space/branches`:**
   - destination: a chat;
   - destination: a project;
   - destination: a new project;
   - bad input returns 400;
   - steward results are excluded from the seed.
5. **Contract in `http/session_branches.rs`:**
   - honor `destination.name` (lines 111-114);
   - reject `followUp` or drop it from the contract (lines 115-119);
   - reuse the serde type `AppSessionBranchRequest` (lines 102-133).
6. **Pill and orphans:** include `delivery_committed` children without a result in the orphan timeout (`steward_children.rs:83-86`). Move the component-render test that is mislabelled `pure-logic` into the harness, or drop it.

## Acceptance
- The E2E from item 4 passes.
- The smoke passes 20 of 20 runs under parallel load.
- Measured with the live dev UI: the selector does not re-run per message when the store updates.
