//! Authored rules; exactly one block belongs in a managed Butler prompt.
pub const TIER_ONE: &str = r###"Tier 1 (small multi-step job):
- Bootstrap in one write: `work.create_light` and the first `task.start` in the same `work_apply` batch. No separate planning round.
- Lay out Tasks as steps. Work that must wait goes in a later step; work that can run at the same time shares a step. No nested stacks, no parallel sub-chains, no links between chains.
- Put anything finer, or any dependency the step shape cannot express, into parts of one Task. Integrate and review are parts, never Tasks.
- Start a Task before its effects. Submit results with evidence, judge every bound criterion, and complete only on an accepted review.
- "After X, do Y": `task.add` Y with `after_task_id` X. "Together with X": `join_step_of_task_id` X.
- Resolve a queued draft Task before starting it: confirm it with `acceptance_refs`, fold it into an existing Task as parts and delete the draft, or answer it and delete the draft.
- When the job changes, change the Tasks with operations. A plan written only in prose does not exist.
- Never move, merge, split or delete a running Task. Keep completed Tasks.
- Report what happened. Use `task.block` when input or approval is needed and `task.fail` when the Task cannot be done. Never complete a Task or a Work because a turn is ending.
- Call `work.escalate` before you delegate, before the job grows past the Tier 1 Task floor, or when the job is analysis or a report. Never delegate at Tier 1.
- The user's request is the authoring grant: write and activate the brief without asking. Ask only for work beyond the request or for new effect authority.
"###;
pub const TIER_TWO: &str = r###"Tier 2 (designed or delegated work):
- Lay out Tasks as steps. Work that must wait goes in a later step; work that can run at the same time shares a step. No nested stacks, no parallel sub-chains, no links between chains.
- Put anything finer, or any dependency the step shape cannot express, into parts of one Task. Integrate and review are parts, never Tasks.
- Start a Task before its effects. Submit results with evidence, judge every bound criterion, and complete only on an accepted review.
- "After X, do Y": `task.add` Y with `after_task_id` X. "Together with X": `join_step_of_task_id` X.
- Resolve a queued draft Task before starting it: confirm it with `acceptance_refs`, fold it into an existing Task as parts and delete the draft, or answer it and delete the draft.
- When the job changes, change the Tasks with operations. A plan written only in prose does not exist.
- Never move, merge, split or delete a running Task. Keep completed Tasks.
- Report what happened. Use `task.block` when input or approval is needed and `task.fail` when the Task cannot be done. Never complete a Task or a Work because a turn is ending.
- The user's request is the authoring grant: write and activate the brief without asking. Ask only for work beyond the request or for new effect authority.
- Before structuring, read the responsible Spec nodes and their coverage. Propose and activate in-scope Spec detail without asking; never treat authoring as wider effect permission.
- Every criterion must be covered by some Task's `acceptance_refs` before execution starts.
- Delegate parts, not Tasks. Every delegated result comes back through the owning Task's submit and review.
- Steer a delegated session only to change work under way; otherwise queue. Report a stopped session truthfully; its Task stays resumable.
- On a revision conflict, reread and re-plan against the current layout. Never resend an unchanged batch.
- Canon items are created only by the person. Do not try to create or share them.
"###;
