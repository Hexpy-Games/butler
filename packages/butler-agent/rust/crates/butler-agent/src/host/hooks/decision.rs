use butler_core::hooks::HookDefinition;
use butler_platform::hook_process::{HookOutput, HookProcessError};
use serde::Deserialize;
#[derive(Default, Deserialize)]
struct Decision {
    decision: Option<String>,
    reason: Option<String>,
    #[serde(rename = "hookSpecificOutput")]
    specific: Option<Specific>,
}
#[derive(Deserialize)]
struct Specific {
    #[serde(rename = "permissionDecision")]
    decision: Option<String>,
    #[serde(rename = "permissionDecisionReason")]
    reason: Option<String>,
    #[serde(rename = "additionalContext")]
    context: Option<String>,
}
/// What one handler's run means for its event.
pub(super) struct Resolved {
    pub(super) outcome: String,
    /// Why the event is blocked, if it is.
    pub(super) deny: Option<String>,
    /// The block comes from the hook failing, not from its decision or a cancellation.
    pub(super) failed: bool,
}
pub(super) fn resolve(
    hook: &HookDefinition,
    output: &Result<HookOutput, HookProcessError>,
) -> Resolved {
    let out = match output {
        Ok(out) => out,
        Err(HookProcessError::Timeout) => {
            let detail = format!("timed out after {} ms", hook.timeout_ms);
            return failure(hook, "timeout", &detail);
        }
        // The turn or the service is stopping: the event still has no answer, but
        // nothing about the hook is wrong.
        Err(error @ HookProcessError::Cancelled) => {
            return Resolved {
                failed: false,
                ..failure(hook, "error", &error.to_string())
            };
        }
        Err(error) => return failure(hook, "error", &error.to_string()),
    };
    if out.exit_code == Some(2) && hook.event.blocks() {
        return deny(hook, out.stderr.trim().to_owned());
    }
    if out.exit_code != Some(0) {
        let detail = out.exit_code.map_or_else(
            || "exited without a code".to_owned(),
            |code| format!("exited with code {code}"),
        );
        return failure(hook, "error", &detail);
    }
    let raw = out.stdout.trim();
    let decision = match serde_json::from_str::<Decision>(raw) {
        Ok(decision) => decision,
        Err(_) if !raw.starts_with('{') && !raw.starts_with('[') => return proceed("continue"),
        // Text may start with a bracket; a hook whose failure blocks has its stdout
        // judged as a decision first.
        Err(_) if super::context::can_add(hook) && !hook.fail_closed => {
            return proceed("continue");
        }
        Err(_) => return failure(hook, "error", "printed invalid JSON"),
    };
    let specific = decision.specific;
    let choice = decision
        .decision
        .as_deref()
        .or_else(|| specific.as_ref().and_then(|s| s.decision.as_deref()));
    let reason = decision
        .reason
        .or_else(|| specific.as_ref().and_then(|s| s.reason.clone()))
        .unwrap_or_default();
    if reason.len() > 16 * 1024 {
        return failure(hook, "error", "printed a reason over 16 KiB");
    }
    match choice {
        Some("deny" | "block") => deny(hook, reason),
        Some("allow" | "ask") => proceed("approval_ignored"),
        None | Some("continue") => proceed("continue"),
        Some(_) => failure(hook, "error", "printed an invalid decision"),
    }
}
/// Text a successful handler's stdout adds: `additionalContext` of a decision,
/// otherwise the whole of a non-JSON stdout. Stdout that failed as a decision
/// never gets here.
pub(super) fn added_context(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let text = match serde_json::from_str::<Decision>(raw) {
        Ok(decision) => decision.specific?.context?,
        Err(_) => raw.to_owned(),
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
/// Only the explicit `additionalContext` of a decision, for hooks whose plain output
/// must not reach the model by accident.
pub(super) fn explicit_context(raw: &str) -> Option<String> {
    let decision = serde_json::from_str::<Decision>(raw.trim()).ok()?;
    let context = decision.specific?.context?;
    let text = context.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
/// Whether stdout looked like a decision but could only be read as text. A
/// broken guard hook looks like this, so the run log says it.
pub(super) fn fell_back_to_text(raw: &str) -> bool {
    let raw = raw.trim();
    (raw.starts_with('{') || raw.starts_with('[')) && serde_json::from_str::<Decision>(raw).is_err()
}
fn proceed(outcome: &str) -> Resolved {
    Resolved {
        outcome: outcome.into(),
        deny: None,
        failed: false,
    }
}
fn deny(hook: &HookDefinition, reason: String) -> Resolved {
    if reason.len() > 16 * 1024 {
        return failure(hook, "error", "printed a reason over 16 KiB");
    }
    if !hook.event.blocks() {
        return proceed("continue");
    }
    let reason = if reason.is_empty() {
        "Blocked by hook".into()
    } else {
        reason
    };
    Resolved {
        outcome: "deny".into(),
        deny: Some(format!("{}: {reason}", hook.label())),
        failed: false,
    }
}
/// A failed hook blocks an event that can be blocked, unless it set `failClosed: false`.
fn failure(hook: &HookDefinition, outcome: &str, detail: &str) -> Resolved {
    let blocked = hook.fail_closed && hook.event.blocks();
    Resolved {
        outcome: outcome.into(),
        deny: blocked.then(|| format!("{}: hook failed ({detail})", hook.label())),
        failed: blocked,
    }
}
