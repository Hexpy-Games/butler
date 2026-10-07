//! Cases for the existing agent-loop history regression: interleaved tabs,
//! partial receipts, repeated preparation and multiple acts on one observation.
#![allow(clippy::unwrap_used, reason = "fixture assertions")]
use super::{
    ModelRoundMessage, ModelRoundRole, ModelRoundToolCall, Value, is_superseded, json, supersede,
};

fn call(
    messages: &mut Vec<ModelRoundMessage>,
    tab: &str,
    obs: &str,
    completed: usize,
    total: usize,
) {
    let id = format!("call-{}", messages.len());
    let args = json!({"tab":tab,"observation":obs,"steps":(0..total).map(|_|json!({"action":"hover","ref":"f0-e2"})).collect::<Vec<_>>()});
    let raw = json!({"id":"native:browser_act","arguments":args}).to_string();
    let mut message = ModelRoundMessage::user(String::new(), None);
    message.role = ModelRoundRole::Assistant;
    message.tool_calls = Some(vec![ModelRoundToolCall {
        id: id.clone(),
        name: "tool_call".into(),
        arguments: serde_json::from_str::<Value>(&raw)
            .unwrap()
            .as_object()
            .unwrap()
            .clone(),
        raw_arguments: raw,
        origin: None,
    }]);
    messages.push(message);
    let steps: Vec<_> = (0..total).map(|n| if n<completed { json!({"status":"completed","still_file":{"file_id":"desktop"},"hit":{"name":"Confirm"}}) } else { json!({"status":"not_dispatched","reason":if n==completed {"stale_ref"}else{"previous_step_failed"}}) }).collect();
    let mut result = tool(
        &json!({"schema":"butler.browser-action.v1","tab":tab,"status":if completed==total {"ok"}else{"interrupted"},"steps":steps}),
    );
    result.tool_call_id = Some(id);
    result.image_attachments = vec![json!({"image_url":"desktop"})];
    messages.push(result);
}
fn tool(output: &Value) -> ModelRoundMessage {
    let mut message = ModelRoundMessage::user(json!({"ok":true,"output":output}).to_string(), None);
    message.role = ModelRoundRole::Tool;
    message
}
fn observe(messages: &mut Vec<ModelRoundMessage>, tab: &str, obs: &str) {
    let mut message = tool(
        &json!({"schema":"butler.browser-observation.v1","tab":tab,"obs":obs,"status":"ok","untrusted_content":{"text":"Confirm"}}),
    );
    message.name = Some("browser_observe".into());
    messages.push(message);
}

pub(in crate::btcc::agent_loop) fn assert_per_tab_cycles() {
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    call(&mut messages, "a", "a1", 2, 10);
    observe(&mut messages, "b", "b1");
    call(&mut messages, "b", "b1", 10, 10);
    observe(&mut messages, "a", "a2");
    call(&mut messages, "a", "a2", 10, 10);
    supersede(&mut messages);
    let old: Value = serde_json::from_str(&messages[0].content).unwrap();
    assert_eq!(
        old["output"]["acted"],
        "hover f0-e2 ×2 completed; #3 not_dispatched stale_ref; 7 not_dispatched"
    );
    let act: Value = serde_json::from_str(&messages[2].content).unwrap();
    assert_eq!(
        act["output"]["steps"],
        "2/10 completed; #3 not_dispatched stale_ref; 7 not_dispatched"
    );
    assert!(!is_superseded(&messages[3].content));
    assert!(!is_superseded(&messages[5].content));
    assert!(!is_superseded(&messages[8].content));
    assert!(
        messages
            .iter()
            .all(|m| m.image_attachments.is_empty() && !m.content.contains("still_file"))
    );
    let once = messages.clone();
    supersede(&mut messages);
    assert_eq!(messages, once);
}

pub(in crate::btcc::agent_loop) fn assert_multiple_acts() {
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    call(&mut messages, "a", "a1", 10, 10);
    call(&mut messages, "a", "a1", 1, 1);
    supersede(&mut messages);
    assert!(is_superseded(&messages[2].content));
    observe(&mut messages, "a", "a2");
    supersede(&mut messages);
    let old: Value = serde_json::from_str(&messages[0].content).unwrap();
    assert_eq!(
        old["output"]["acted"],
        "hover f0-e2 ×10 completed; hover f0-e2 ×1 completed"
    );
    let once = messages.clone();
    supersede(&mut messages);
    assert_eq!(messages, once);
}
