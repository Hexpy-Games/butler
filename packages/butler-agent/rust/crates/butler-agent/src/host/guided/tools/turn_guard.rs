//! Per-turn access state beyond the pure decision: whether the turn already
//! read external content (D5), and whether anyone can answer an approval at
//! all (D8: unattended schedule runs never wait).

use butler_core::json::JsonDocument;
use butler_turn::btcc::{AuthorityLoopContinuation, ToolExecutionError, TurnTaint};
use serde_json::{Map, Value, json};

use super::GuidedTools;

/// The continuation extension that carries the taint across a suspension.
const TAINT_KEY: &str = "turnTaint";
/// The continuation extension that carries the turn's web provenance and
/// search result ids across a suspension.
const WEB_KEY: &str = "turnWeb";

/// A schedule run nobody attends. The ids are absent for schedules the agent
/// dispatches itself, which have no App run to flag.
#[derive(Clone, Debug)]
pub(crate) struct UnattendedRun {
    automation_id: Option<String>,
    run_id: Option<String>,
    scheduled_at: Option<String>,
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
            scheduled_at: text("scheduled_at"),
        })
    }
}

/// The taint a turn starts with: restored from its authority continuation,
/// or external when the user message carries attachments.
fn initial_taint(context: &Value, restored: Option<&AuthorityLoopContinuation>) -> TurnTaint {
    let resumed = restored
        .and_then(|continuation| continuation.extensions.get(TAINT_KEY))
        .and_then(Value::as_str);
    if resumed == Some("connector_event")
        || context["messageOrigin"] == "connector"
        || context["scheduleRun"]["connector_event"] == true
    {
        return TurnTaint::ConnectorEvent;
    }
    let attached = context
        .get("attachments")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    if resumed == Some("external") || attached {
        TurnTaint::External
    } else {
        TurnTaint::Clean
    }
}

/// The web provenance a turn starts with: URLs in the user's message, plus
/// what the turn found and the result ids it handed out before a suspension.
pub(super) fn restore_web(
    session: &butler_runtime::web_access::WebSession,
    message: &str,
    restored: Option<&AuthorityLoopContinuation>,
) {
    if let Some(saved) = restored.and_then(|continuation| continuation.extensions.get(WEB_KEY)) {
        session.restore(saved);
    }
    for url in super::dispatch::web_provenance(message) {
        session.discover(&url);
    }
}

/// Tools whose results bring in content from the web, a connector or a page,
/// including a command that reaches the network.
fn reads_external(name: &str, args: &Value) -> bool {
    (name == "run_command" && args["state_effect"] == "remote_observation")
        || matches!(
            name,
            "browse"
                | "web_search"
                | "web_read"
                | "call_mcp_tool"
                | "read_mcp_resource"
                | "connector_fetch"
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
        let mut taint = self.turn_taint.lock();
        if *taint == TurnTaint::Clean {
            *taint = TurnTaint::External;
        }
    }

    /// Records the taint a finished call of `effective_name` brings in.
    pub(super) fn observe_result(&self, effective_name: &str, args: &Value) {
        if reads_external(effective_name, args) {
            self.mark_external();
        }
    }

    pub(super) fn taint_extensions(&self) -> Map<String, Value> {
        let mut extensions = Map::new();
        match self.taint() {
            TurnTaint::Clean => (),
            TurnTaint::External => {
                extensions.insert(TAINT_KEY.into(), "external".into());
            }
            TurnTaint::ConnectorEvent => {
                extensions.insert(TAINT_KEY.into(), "connector_event".into());
            }
        }
        if let Some(web) = self.web_session.snapshot() {
            extensions.insert(WEB_KEY.into(), web);
        }
        extensions
    }

    pub(super) async fn refresh_instruction_context(&self) -> Result<(), ToolExecutionError> {
        let run = self
            .subsessions
            .instruction_run_context(&self.binding.source_session_id)
            .await
            .map_err(ToolExecutionError::Integrity)?;
        if let Some(run) = run {
            if run.connector_event {
                *self.turn_taint.lock() = TurnTaint::ConnectorEvent;
            }
            *self.instruction_run.lock() = Some(run);
        }
        Ok(())
    }

    pub(super) fn unattended(&self) -> bool {
        self.instruction_run
            .lock()
            .as_ref()
            .map_or(self.binding.turn_guard.unattended.is_some(), |run| {
                run.unattended
            })
    }

    /// Preserve attendance and event origin in every delegated child.
    pub(super) fn inherited_run(&self) -> Option<butler_turn::btcc::ScheduleRunContext> {
        let run = self.binding.turn_guard.unattended.as_ref();
        let connector_event = self.taint() == TurnTaint::ConnectorEvent;
        let inherited = self.instruction_run.lock().clone();
        if run.is_none() && !connector_event && inherited.is_none() {
            return None;
        }
        let mut result = inherited.unwrap_or(butler_turn::btcc::ScheduleRunContext {
            automation_id: run
                .and_then(|r| r.automation_id.clone())
                .unwrap_or_default(),
            run_id: run.and_then(|r| r.run_id.clone()).unwrap_or_default(),
            unattended: run.is_some(),
            connector_event,
            scheduled_at: run.and_then(|r| r.scheduled_at.clone()),
        });
        result.connector_event |= connector_event;
        Some(result)
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
pub(super) fn unattended_result(
    owner: &GuidedTools,
    capability: &str,
    subject: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let value = unattended_feedback(owner, capability, subject);
    JsonDocument::from_value(&value).map_err(super::effect::wire_error)
}

pub(super) fn unattended_feedback(owner: &GuidedTools, capability: &str, subject: &str) -> Value {
    json!({"ok":false,"error":{
        "reason": (owner.taint() != TurnTaint::Clean)
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

/// A denied scheduled action needs a different mode, rather than a waiting review.
pub(super) async fn unattended_denial(
    owner: &GuidedTools,
    call: &butler_turn::btcc::ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    super::attention::skipped_call(owner, call).await;
    let subject = call
        .arguments
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or(&call.name);
    unattended_result(owner, &call.name, subject)
}
