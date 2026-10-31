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

/// What a turn starts with: whether anyone attends it, and its taint.
#[derive(Clone, Debug)]
pub(crate) struct TurnGuard {
    pub(super) schedule_run: Option<butler_turn::btcc::ScheduleRunContext>,
    pub(super) initial_taint: TurnTaint,
}

impl TurnGuard {
    pub(crate) fn new(context: &Value, restored: Option<&AuthorityLoopContinuation>) -> Self {
        Self {
            schedule_run: context
                .get("scheduleRun")
                .cloned()
                .and_then(|run| serde_json::from_value(run).ok()),
            initial_taint: initial_taint(context, restored),
        }
    }
}

/// The taint a turn starts with: restored from its authority continuation,
/// or external when the user message carries attachments or a project folder's
/// hook added text: that text can ask the model to send something out.
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
    if resumed == Some("external") || attached || context["hookContextProject"] == true {
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
                | "browser_devtools"
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

    fn current_run(&self) -> Option<butler_turn::btcc::ScheduleRunContext> {
        self.instruction_run
            .lock()
            .clone()
            .or_else(|| self.binding.turn_guard.schedule_run.clone())
            .map(|mut run| {
                // Older schedule contexts have no switch snapshot; keep them off.
                if run.browser.is_none()
                    && !run.connector_event
                    && (run.unattended || !run.automation_id.is_empty() || !run.run_id.is_empty())
                {
                    run.browser = Some(Default::default());
                }
                run
            })
    }

    pub(super) fn unattended(&self) -> bool {
        self.current_run().is_some_and(|run| run.unattended)
    }

    /// Browser switches apply to schedules, not standalone connector events.
    pub(super) fn schedule_run(&self) -> Option<butler_turn::btcc::ScheduleRunContext> {
        self.current_run().filter(|run| run.browser.is_some())
    }

    /// Keep the complete schedule snapshot while inheriting connector provenance.
    pub(super) fn inherited_run(&self) -> Option<butler_turn::btcc::ScheduleRunContext> {
        let connector_event = self.taint() == TurnTaint::ConnectorEvent;
        let mut result = self.current_run().or_else(|| {
            connector_event.then(|| butler_turn::btcc::ScheduleRunContext {
                automation_id: String::new(),
                run_id: String::new(),
                unattended: false,
                connector_event,
                scheduled_at: None,
                browser: None,
            })
        })?;
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

/// The same fail-fast response and run attention for scheduled and Run now turns.
pub(super) async fn schedule_browser_feedback(
    owner: &GuidedTools,
    call: &butler_turn::btcc::ModelRoundToolCall,
    input: &Value,
    target: &str,
    code: &str,
) -> Option<Value> {
    let message = match code {
        "schedule_signin_off" => {
            "This schedule's Use sign-in info option (로그인 정보 사용) is off, so this run cannot use signed-in sites."
        }
        "schedule_payment_off" => {
            "This schedule's Use payment info option (결제 정보 사용) is off, so this run cannot pay."
        }
        _ => return None,
    };
    super::attention::skipped_input(owner, call, input.clone(), target, code).await;
    Some(
        json!({"ok":false,"status":"not_dispatched","reason":code,"error":{
            "code":code,"message":message,"recoverable":true,"next_action":super::feedback::repair(code)
        }}),
    )
}
