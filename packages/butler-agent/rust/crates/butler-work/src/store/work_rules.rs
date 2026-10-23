//! Authored compact rules; inject Core plus only the current tier lines.
pub const TIER_ONE: &str = r#"Tier 1 (small multi-step job):
- Work that must wait goes in a later step; work that can run together shares one.
- Start a Task before its effects. Submit with evidence, judge every bound criterion, and complete only on accepted review.
- "After X, do Y": `after_task_id` X. "With X": `join_step_of_task_id` X.
- A delivered queued message is the next request in this Work. Resolve its draft Task first, as the delivery says, and never start a draft.
- Change Tasks with operations; a plan in prose only does not count.
- Report truthfully: `task.block` for input or approval, `task.fail` when it cannot be done.
- Planned Tasks run in their own sessions when their step is ready. Don't `task.start` them here; report their results when delivered.
- If the user asks to do a 작업 here, create it with `run_here: true` and run it yourself.
- The request is the authoring grant: write and activate in-scope Spec without asking. Ask only for work beyond it or for new effect authority; authoring never widens effect permission.
- Bootstrap in one batch: `work.create_light` plus the first `task.start`. No planning round.
- Never delegate at Tier 1. Call `work.escalate` before delegating, before passing the Task floor, or for analysis or report work.
"#;
pub const TIER_TWO: &str = r#"Tier 2 (designed or delegated work):
- Work that must wait goes in a later step; work that can run together shares one.
- Start a Task before its effects. Submit with evidence, judge every bound criterion, and complete only on accepted review.
- "After X, do Y": `after_task_id` X. "With X": `join_step_of_task_id` X.
- A delivered queued message is the next request in this Work. Resolve its draft Task first, as the delivery says, and never start a draft.
- Change Tasks with operations; a plan in prose only does not count.
- Report truthfully: `task.block` for input or approval, `task.fail` when it cannot be done.
- Planned Tasks run in their own sessions when their step is ready. Don't `task.start` them here; report their results when delivered.
- If the user asks to do a 작업 here, create it with `run_here: true` and run it yourself.
- The request is the authoring grant: write and activate in-scope Spec without asking. Ask only for work beyond it or for new effect authority; authoring never widens effect permission.
- Read the responsible Spec and coverage before structuring. Every criterion needs a Task's `acceptance_refs` before execution.
"#;
