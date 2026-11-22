//! Capabilities another Butler's remote computer does not offer (browser, dev-server preview,
//! schedules), and conversation memory reads the main answers.
use super::GuidedTools;
use butler_turn::btcc::ModelRoundToolCall;
use serde_json::{Map, Value, json};

const UNAVAILABLE: &[&str] = &[
    "browse",
    "browser_open",
    "browser_observe",
    "browser_read",
    "browser_act",
    "browser_tabs",
    "browser_selection",
    "browser_devtools",
    "browser_screenshot",
    "image_collect",
    "browser_close",
    "browser_wait_for_user",
    "browser_sign_in",
    "browser_pay_fill",
    "browser_autofill_fill",
    "browser_history_search",
    "preview_start",
    "preview_stop",
    "create_automation",
    "update_automation",
    "delete_automation",
    "list_automations",
    "run_due_automations",
];

pub(super) fn unavailable(name: &str) -> bool {
    butler_models::models::sealed::is_enabled() && UNAVAILABLE.contains(&name)
}

const MAIN_NOT_CONNECTED: &str = "Not connected to the main device.";

/// On a remote computer, reads of the main's conversations ask the main;
/// the active conversation's own context (`read_conversation_context`) stays here.
pub(super) fn reads_main(name: &str) -> bool {
    butler_models::models::sealed::is_enabled()
        && matches!(
            name,
            "recall_memory"
                | "query_memory"
                | "list_conversation_sessions"
                | "read_conversation_session"
        )
}

/// The main's answer as the tool result, or a fixed failure when no main is
/// connected or it does not answer in time. The turn goes on either way.
pub(super) async fn ask_main(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
    arguments: Value,
) -> Value {
    let memory = &owner.binding.memory;
    let request = Map::from_iter([
        ("session_id".to_owned(), json!(memory.runtime_session_id)),
        ("turn_id".to_owned(), json!(memory.turn_id)),
        ("tool".to_owned(), json!(call.name)),
        ("arguments".to_owned(), arguments),
        (
            "current_user_message".to_owned(),
            json!(owner.binding.current_user_message),
        ),
        ("operation_id".to_owned(), json!(call_id)),
    ]);
    let Some(mut answer) = butler_turn::remote_memory::ask(request).await else {
        return json!({"ok":false,"error":{"code":"main_not_connected","message":MAIN_NOT_CONNECTED}});
    };
    if let Some(result) = answer.get_mut("result") {
        return result.take();
    }
    super::message::tool_failure(&call.name, answer["error"].as_str().unwrap_or("tool_error"))
}
