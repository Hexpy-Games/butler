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
}
pub(super) fn resolve(
    hook: &HookDefinition,
    output: &Result<HookOutput, HookProcessError>,
) -> (String, Option<String>) {
    let out = match output {
        Ok(out) => out,
        Err(e) => {
            return failure(
                hook,
                if matches!(e, HookProcessError::Timeout) {
                    "timeout"
                } else {
                    "error"
                },
                &e.to_string(),
            );
        }
    };
    if out.exit_code == Some(2) && hook.event.blocks() {
        return deny(hook, out.stderr.trim().to_owned());
    }
    if out.exit_code != Some(0) {
        return failure(
            hook,
            "error",
            &format!("Hook '{}' exited with {:?}", hook.label(), out.exit_code),
        );
    }
    let raw = out.stdout.trim();
    let decision = match serde_json::from_str::<Decision>(raw) {
        Ok(decision) => decision,
        Err(_) if !raw.starts_with('{') && !raw.starts_with('[') => {
            return ("continue".into(), None);
        }
        Err(_) => return failure(hook, "error", "Invalid hook decision JSON"),
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
        return failure(hook, "error", "Hook reason exceeds 16 KiB");
    }
    match choice {
        Some("deny" | "block") => deny(hook, reason),
        Some("allow" | "ask") => ("approval_ignored".into(), None),
        None | Some("continue") => ("continue".into(), None),
        Some(_) => failure(hook, "error", "Invalid hook decision"),
    }
}
fn deny(hook: &HookDefinition, reason: String) -> (String, Option<String>) {
    if reason.len() > 16 * 1024 {
        return failure(hook, "error", "Hook reason exceeds 16 KiB");
    }
    if !hook.event.blocks() {
        return ("continue".into(), None);
    }
    let reason = if reason.is_empty() {
        "Blocked by hook".into()
    } else {
        reason
    };
    ("deny".into(), Some(format!("{}: {reason}", hook.label())))
}
fn failure(hook: &HookDefinition, outcome: &str, reason: &str) -> (String, Option<String>) {
    let blocked = hook.fail_closed && hook.event.blocks();
    (
        outcome.into(),
        blocked.then(|| format!("{}: {reason}", hook.label())),
    )
}
