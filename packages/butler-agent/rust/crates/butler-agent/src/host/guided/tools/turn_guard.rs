//! Per-turn access state beyond the pure decision: whether the turn already
//! read external content (D5), and whether anyone can answer an approval at
//! all (D8: unattended schedule runs never wait).

use butler_core::json::JsonDocument;
use butler_turn::btcc::{AuthorityLoopContinuation, ToolExecutionError, TurnTaint};
use reqwest::Method;
use serde_json::{Map, Value, json};

use super::GuidedTools;

/// The continuation extension that carries the taint across a suspension.
const TAINT_KEY: &str = "turnTaint";

/// A schedule run nobody attends. The ids are absent for schedules the agent
/// dispatches itself, which have no App run to flag.
#[derive(Clone, Debug)]
pub(crate) struct UnattendedRun {
    automation_id: Option<String>,
    run_id: Option<String>,
}

/// What a turn starts with: whether anyone attends it, and its taint.
#[derive(Clone, Debug)]
pub(crate) struct TurnGuard {
    pub(super) unattended: Option<UnattendedRun>,
    pub(super) initial_taint: TurnTaint,
}

impl TurnGuard {
    pub(crate) fn new(context: &Value, restored: Option<&AuthorityLoopContinuation>) -> Self {
        Self {
            unattended: UnattendedRun::from_context(context),
            initial_taint: initial_taint(context, restored),
        }
    }
}

impl UnattendedRun {
    /// The unattended run the turn context marks (`scheduleRun`), if any.
    fn from_context(context: &Value) -> Option<Self> {
        let run = context.get("scheduleRun")?;
        let text = |key: &str| {
            run.get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        (run.get("unattended") == Some(&Value::Bool(true))).then(|| Self {
            automation_id: text("automation_id"),
            run_id: text("run_id"),
        })
    }
}

/// The taint a turn starts with: restored from its authority continuation,
/// or external when the user message carries attachments.
fn initial_taint(context: &Value, restored: Option<&AuthorityLoopContinuation>) -> TurnTaint {
    let resumed = restored
        .and_then(|continuation| continuation.extensions.get(TAINT_KEY))
        .and_then(Value::as_str)
        == Some("external");
    let attached = context
        .get("attachments")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    if resumed || attached {
        TurnTaint::External
    } else {
        TurnTaint::Clean
    }
}

/// Tools whose results bring in content from the web, a connector or a page,
/// including a command that reaches the network.
fn reads_external(name: &str, args: &Value) -> bool {
    (name == "run_command" && args["state_effect"] == "remote_observation")
        || matches!(
            name,
            "web_search"
                | "web_read"
                | "call_mcp_tool"
                | "read_mcp_resource"
                | "browser_open"
                | "browser_observe"
                | "browser_act"
                | "browser_selection"
                | "browser_screenshot"
                | "browser_tabs"
        )
}

impl GuidedTools {
    pub(super) fn taint(&self) -> TurnTaint {
        *self.turn_taint.lock()
    }

    /// The turn read content from outside the project and the user.
    pub(super) fn mark_external(&self) {
        *self.turn_taint.lock() = TurnTaint::External;
    }

    /// Records the taint a finished call of `effective_name` brings in.
    pub(super) fn observe_result(&self, effective_name: &str, args: &Value) {
        if reads_external(effective_name, args) {
            self.mark_external();
        }
    }

    pub(super) fn taint_extensions(&self) -> Map<String, Value> {
        let mut extensions = Map::new();
        if self.taint() == TurnTaint::External {
            extensions.insert(TAINT_KEY.into(), "external".into());
        }
        extensions
    }

    pub(super) fn unattended(&self) -> bool {
        self.binding.turn_guard.unattended.is_some()
    }

    /// The unattended run a delegated child inherits, so it cannot wait either.
    pub(super) fn unattended_run(&self) -> Option<butler_turn::btcc::ScheduleRunContext> {
        let run = self.binding.turn_guard.unattended.as_ref()?;
        Some(butler_turn::btcc::ScheduleRunContext {
            automation_id: run.automation_id.clone().unwrap_or_default(),
            run_id: run.run_id.clone().unwrap_or_default(),
            unattended: true,
        })
    }
}

/// What a grant for `capability` would cover, for the run report.
fn grant_kind(capability: &str) -> &'static str {
    match capability {
        "run_command_remote_observation" => "network",
        "run_command" => "command",
        "call_mcp_tool" => "connector",
        "web_search" | "web_read" => "web_request",
        "write_file" | "edit_file" => "file_edit",
        "read_file" | "list_files" | "grep_files" => "file_read",
        "create_automation" | "update_automation" | "delete_automation" | "run_due_automations" => {
            "schedule"
        }
        "set_wallpaper" | "save_wallpaper_module" => "settings",
        "start_topic_conversation" => "conversation",
        name if name.starts_with("browser_") => "browser",
        _ => "other",
    }
}

/// D8: the result an unattended run gets instead of an approval it cannot
/// receive. No authority request exists; the run reports the skipped step.
pub(super) async fn unattended_result(
    owner: &GuidedTools,
    capability: &str,
    subject: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let value = unattended_feedback(owner, capability, subject).await;
    JsonDocument::from_value(&value).map_err(super::effect::wire_error)
}

pub(super) async fn unattended_feedback(
    owner: &GuidedTools,
    capability: &str,
    subject: &str,
) -> Value {
    notify(owner).await;
    json!({"ok":false,"error":{
        "reason": (owner.taint() == TurnTaint::External)
            .then_some("This run read outside content, so the step needs a fresh permission."),
        "code":"schedule_permission_required",
        "message":"This scheduled run cannot ask for permission, so this step did not run.",
        "recoverable":true,
        "required_grant":{"kind":grant_kind(capability),"subject":subject},
        "next_action":super::feedback::repair("schedule_permission_required"),
    }})
}

/// D8 for questions: an unattended run cannot wait for an answer either.
pub(super) fn unattended_question() -> Value {
    json!({"ok":false,"error":{
        "code":"schedule_question_unavailable",
        "message":"This scheduled run cannot ask the user.",
        "recoverable":true,
        "next_action":super::feedback::repair("schedule_question_unavailable"),
    }})
}

/// Flags the App run once per turn so the schedule shows it needs permission.
/// Best effort: the model still reports the skipped step if this fails.
async fn notify(owner: &GuidedTools) {
    let Some(run) = owner.binding.turn_guard.unattended.as_ref() else {
        return;
    };
    let (Some(automation), Some(run_id)) = (&run.automation_id, &run.run_id) else {
        return;
    };
    if std::mem::replace(&mut *owner.attention_sent.lock(), true) {
        return;
    }
    let Ok(client) = crate::host::automation::client::ScheduleClient::active(&owner.app_endpoint)
    else {
        return;
    };
    let path = format!(
        "/automations/{}/runs/{}/attention",
        encode(automation),
        encode(run_id)
    );
    let body = json!({"code":"schedule_permission_required", "tainted":owner.taint() == TurnTaint::External});
    let _ = client.request(Method::POST, &path, Some(body)).await;
}

fn encode(segment: &str) -> String {
    url::form_urlencoded::byte_serialize(segment.as_bytes()).collect()
}

/// A denied scheduled action needs a different mode, rather than a waiting review.
pub(super) async fn unattended_denial(
    owner: &GuidedTools,
    call: &butler_turn::btcc::ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let subject = call
        .arguments
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or(&call.name);
    unattended_result(owner, &call.name, subject).await
}
