//! Authored rejection text shared by model tools and their runtime boundaries.
use serde_json::{Value, json};
pub const INSTRUCTION_PENDING: &str = "A steer from your parent has not been delivered yet. Call work_read or continue your work to receive it, apply it, then submit or complete.";
pub const NO_STARTED_TASK: &str = "Delegation needs a started Task to hold the part. Call work_apply with task.start on the Task this work belongs to, then delegate again.";
pub const CUTOVER_PENDING: &str = "An update is finishing. Your request is kept and runs automatically afterwards. Do not retry; tell the user it will continue shortly.";
pub const TIER1_FLOOR: &str = "This Tier 1 Work cannot grow past 5 Tasks. Call work_apply with work.escalate to raise it to Tier 2, then add the Tasks; ids are kept.";
pub fn task_not_started(task: &str) -> String {
    format!(
        "This goal has a Work, so effects need a started Task. Call work_apply with task.start on the Task this belongs to, or continue the running Task {task} if one is running."
    )
}
pub fn parent_control_forbidden(session: &str) -> String {
    format!(
        "Session {session} is not a session you delegated to, so you cannot control it. Use session_control only on your own delegated sessions."
    )
}
pub fn conflict(what: &str) -> String {
    format!(
        "Another change landed first ({what}). Reread the affected view with work_read, re-plan against it, and send a new batch instead of the same one."
    )
}
pub fn stale(entity: &str, id: &str, revision: i64) -> String {
    format!(
        "{entity} {id} changed after your read (now revision {revision}). Reread it with work_read, apply your change to the current fields, and resend with revision {revision}."
    )
}
pub fn rejected(reason: &str) -> String {
    format!(
        "The batch was rejected: {reason}. Fix that and resend; nothing in the batch was applied."
    )
}
pub fn refusal(code: &str, message: impl Into<String>) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message.into()}})
}
pub fn from_error(error: &super::Error) -> Option<Value> {
    let (code, message) = match error {
        super::Error::Invalid("no_started_task") => ("no_started_task", NO_STARTED_TASK.to_owned()),
        super::Error::Invalid("tier1_floor_exceeded") => {
            ("tier1_floor_exceeded", TIER1_FLOOR.to_owned())
        }
        super::Error::Conflict { current } => ("conflict", conflict(&current.to_string())),
        super::Error::Invalid(reason) => ("work_apply_rejected", rejected(reason)),
        super::Error::NotFound => ("work_apply_rejected", rejected("missing execution row")),
        _ => return None,
    };
    Some(refusal(code, message))
}
