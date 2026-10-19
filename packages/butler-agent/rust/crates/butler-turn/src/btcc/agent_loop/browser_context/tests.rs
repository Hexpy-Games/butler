//! Cases for the existing agent-loop history regression: interleaved tabs,
//! partial receipts, repeated preparation and multiple acts on one observation.
#![allow(clippy::unwrap_used, reason = "fixture assertions")]
use super::{
    BrowserPrune, ModelRoundMessage, ModelRoundRole, ModelRoundToolCall, Value, is_superseded,
    json, plan, prune,
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
    assert_budget_boundaries();
    assert_resumed_summary_floor();
    assert_resolved_tab();
    assert_zoom_and_byte_guard();
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    call(&mut messages, "a", "a1", 2, 10);
    observe(&mut messages, "b", "b1");
    call(&mut messages, "b", "b1", 10, 10);
    observe(&mut messages, "a", "a2");
    call(&mut messages, "a", "a2", 10, 10);
    force_prune(&mut messages);
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
    force_prune(&mut messages);
    assert_eq!(messages, once);
    observe(&mut messages, "a", "a3");
    force_prune(&mut messages);
    assert_eq!(
        messages[..6],
        once[..6],
        "written stubs never change, so the provider prefix before them stays cached"
    );
    let updated: Value = serde_json::from_str(&messages[0].content).unwrap();
    assert_eq!(updated["output"]["superseded_by"], "a2");
    assert_eq!(updated["output"]["tab"], "a");
    assert_eq!(updated["output"]["acted"], old["output"]["acted"]);
    let replaced: Value = serde_json::from_str(&messages[6].content).unwrap();
    assert_eq!(replaced["output"]["superseded_by"], "a3");
    assert!(
        !is_superseded(&messages[3].content),
        "another tab's latest stays intact"
    );
}

pub(in crate::btcc::agent_loop) fn assert_multiple_acts() {
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    call(&mut messages, "a", "a1", 10, 10);
    call(&mut messages, "a", "a1", 1, 1);
    force_prune(&mut messages);
    assert!(is_superseded(&messages[2].content));
    observe(&mut messages, "a", "a2");
    force_prune(&mut messages);
    let old: Value = serde_json::from_str(&messages[0].content).unwrap();
    assert_eq!(
        old["output"]["acted"],
        "hover f0-e2 ×10 completed; hover f0-e2 ×1 completed"
    );
    let once = messages.clone();
    force_prune(&mut messages);
    assert_eq!(messages, once);
}

/// `browser_act {observe:true}` closes its source cycle and opens the next one.
pub(in crate::btcc::agent_loop) fn assert_act_with_observation() {
    assert_frozen_receipt();
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    observed_act(&mut messages, "a1", "a2");
    observed_act(&mut messages, "a2", "a3");
    force_prune(&mut messages);
    let first: Value = serde_json::from_str(&messages[0].content).unwrap();
    assert_eq!(first["output"]["superseded_by"], "a2");
    assert_eq!(first["output"]["acted"], "hover f0-e2 ×2 completed");
    let middle: Value = serde_json::from_str(&messages[2].content).unwrap();
    assert_eq!(middle["output"]["status"], "superseded");
    assert_eq!(middle["output"]["obs"], "a2");
    assert_eq!(middle["output"]["acted"], "hover f0-e2 ×2 completed");
    let latest: Value = serde_json::from_str(&messages[4].content).unwrap();
    assert!(!is_superseded(&messages[4].content));
    assert_eq!(
        latest["output"]["action"]["steps"][1]["status"],
        "completed"
    );
    assert!(messages.iter().all(|m| !m.content.contains("still_file")));
    let once = messages.clone();
    force_prune(&mut messages);
    assert_eq!(messages, once);
}
fn assert_frozen_receipt() {
    let mut messages = Vec::new();
    observe(&mut messages, "a", "o5");
    let frozen = messages[0].clone();
    let mut state = BrowserPrune {
        watermark: 1,
        ..Default::default()
    };
    observed_act(&mut messages, "o5", "o6");
    let mut value: Value = serde_json::from_str(&messages[2].content).unwrap();
    value["output"]["untrusted_content"]["text"] = "x".repeat(70_000).into();
    messages[2].content = value.to_string().into();
    observed_act(&mut messages, "o6", "o7");
    prune(&mut messages, &mut state, 0, u64::MAX);
    assert_eq!(messages[0], frozen, "normal prune keeps frozen source full");
    let stub: Value = serde_json::from_str(&messages[2].content).unwrap();
    assert_eq!(stub["output"]["receipt"]["obs"], "o5");
    assert_eq!(
        stub["output"]["receipt"]["acted"],
        "hover f0-e2 ×2 completed"
    );
    let once = messages[2].clone();
    prune(&mut messages, &mut state, 0, 0);
    let source: Value = serde_json::from_str(&messages[0].content).unwrap();
    assert_eq!(
        source["output"]["acted"],
        stub["output"]["receipt"]["acted"]
    );
    assert_eq!(messages[2], once, "deep prune keeps receipt stub immutable");
    assert!(source["output"].get("receipt").is_none());
}

fn observed_act(messages: &mut Vec<ModelRoundMessage>, source: &str, next: &str) {
    call(messages, "a", source, 2, 2);
    let steps =
        json!([{"status":"completed","still_file":{"file_id":"desktop"}},{"status":"completed"}]);
    let mut result = tool(
        &json!({"schema":"butler.browser-observation.v1","tab":"a","obs":next,"status":"ok","still_file":{"file_id":"desktop"},
            "untrusted_content":{"text":"Confirm"},"action":{"schema":"butler.browser-action.v1","status":"ok","steps":steps}}),
    );
    result.tool_call_id = messages.pop().unwrap().tool_call_id;
    messages.push(result);
}

fn force_prune(messages: &mut [ModelRoundMessage]) {
    // Normalize fresh still metadata before establishing the sent prefix.
    let mut state = BrowserPrune::default();
    prune(messages, &mut state, 0, u64::MAX);
    let before = messages.to_vec();
    let planned = plan(messages);
    assert_eq!(messages, before, "planning never mutates history");
    for stale in &planned {
        let mut value: Value = serde_json::from_str(&messages[stale.index].content).unwrap();
        value["output"]["untrusted_content"] = json!({"text":"x".repeat(70_000)});
        messages[stale.index].content = value.to_string().into();
    }
    prune(messages, &mut state, 0, u64::MAX);
    for stale in planned {
        assert_eq!(
            messages[stale.index].content, stale.stub,
            "stub bytes are final"
        );
    }
}

fn sized_observation(messages: &mut Vec<ModelRoundMessage>, index: usize, bytes: usize) {
    observe(messages, "a", &format!("a{index}"));
    let message = messages.last_mut().unwrap();
    let mut value: Value = serde_json::from_str(&message.content).unwrap();
    value["output"]["untrusted_content"]["text"] = "x".repeat(bytes).into();
    message.content = value.to_string().into();
}

fn assert_budget_boundaries() {
    let mut messages = Vec::new();
    let mut state = BrowserPrune::default();
    for index in 0..4 {
        sized_observation(&mut messages, index, 19_000);
    }
    let before = messages.clone();
    prune(&mut messages, &mut state, 0, u64::MAX);
    assert_eq!(messages, before, "under budget stays full");
    sized_observation(&mut messages, 4, 19_000);
    prune(&mut messages, &mut state, 0, u64::MAX);
    assert_eq!(state.watermark, 5);
    assert!(messages[..4].iter().all(|m| is_superseded(&m.content)));
    assert!(!is_superseded(&messages[4].content));
    let once = messages.clone();
    prune(&mut messages, &mut state, 0, u64::MAX);
    assert_eq!(messages, once, "second call is a no-op");
    for index in 5..9 {
        sized_observation(&mut messages, index, 19_000);
    }
    prune(&mut messages, &mut state, 0, u64::MAX);
    assert_eq!(messages[..5], once, "normal prune preserves frozen range");
    let watermark = state.watermark;
    for index in 9..13 {
        sized_observation(&mut messages, index, 19_000);
    }
    let frozen = messages[..watermark].to_vec();
    prune(&mut messages, &mut state, 0, u64::MAX);
    assert!(
        is_superseded(&messages[4].content),
        "frozen total over half budget triggers deep prune"
    );
    assert_ne!(messages[..watermark], frozen);
    sized_observation(&mut messages, 13, 19_000);
    let mut floor_state = BrowserPrune::default();
    let before = messages.clone();
    prune(&mut messages, &mut floor_state, before.len(), 0);
    assert_eq!(messages, before, "covered summary source is immutable");
    let mut image = tool(&json!({"image":{"mime_type":"image/jpeg","data":"a".repeat(100_000)}}));
    let stale = super::prune::Stale::new(0, &image, "stub".into());
    assert_eq!(
        stale.tokens,
        (image.content.len() - 100_000).div_ceil(4) + 1_600
    );
    image.content = "plain text".into();
    assert_eq!(super::prune::Stale::new(0, &image, "stub".into()).tokens, 3);
}

fn assert_resolved_tab() {
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    call(&mut messages, "a", "a1", 1, 1);
    call(&mut messages, "a", "a1", 1, 1);
    let call = messages[3]
        .tool_calls
        .as_mut()
        .unwrap()
        .first_mut()
        .unwrap();
    let mut args: Value = serde_json::from_str(&call.raw_arguments).unwrap();
    args["arguments"].as_object_mut().unwrap().remove("tab");
    call.raw_arguments = args.to_string();
    call.arguments = args.as_object().unwrap().clone();
    force_prune(&mut messages);
    assert!(is_superseded(&messages[2].content));
    assert!(
        !is_superseded(&messages[4].content),
        "output tab resolves the latest act without a tab argument"
    );
}

fn assert_zoom_and_byte_guard() {
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    messages.push(tool(&json!({"schema":"butler.browser-zoom.v1","tab":"a","image":{"mime_type":"image/jpeg","data":"a".repeat(100_000)}})));
    observe(&mut messages, "a", "a2");
    messages.push(tool(&json!({"schema":"butler.browser-zoom.v1","tab":"a","image":{"mime_type":"image/jpeg","data":"b".repeat(100_000)}})));
    let planned = plan(&messages);
    assert_eq!(planned.len(), 2, "older observation and close-up are stale");
    let newest = messages[2..].to_vec();
    let mut state = BrowserPrune::default();
    prune(&mut messages, &mut state, 1, 200_000);
    assert!(
        !is_superseded(&messages[0].content),
        "covered source stays immutable"
    );
    assert!(
        is_superseded(&messages[1].content),
        "stale JPEG crosses byte guard below token budget"
    );
    assert_eq!(messages[2..], newest);
    assert_eq!(
        messages[1].content,
        planned.iter().find(|s| s.index == 1).unwrap().stub
    );
}

fn assert_resumed_summary_floor() {
    use crate::btcc::agent_loop::{
        continuation::AuthorityLoopContinuation, contracts::PreparedPolicy,
        guided_types::FinalSynthesis, state::State,
    };
    let mut prepared = PreparedPolicy {
        prompt: String::new(),
        instructions: None,
        tools: vec![],
        tool_choice: None,
        resumed_tool_call: None,
        authority_decision: None,
        images: Default::default(),
        request: Default::default(),
        ports: Default::default(),
        final_synthesis: FinalSynthesis::Never,
    };
    let mut continuation = AuthorityLoopContinuation::fixture("request", "call");
    continuation.messages.clear();
    for index in 0..4 {
        sized_observation(&mut continuation.messages, index, 70_000);
    }
    // An active summary covers the first two source messages (exclusive floor).
    continuation
        .extensions
        .insert("browserPruneFloor".into(), json!(2));
    continuation
        .extensions
        .insert("browserPruneWatermark".into(), json!(3));
    let encoded = serde_json::to_string(&continuation).unwrap();
    let mut state = State::resumed(serde_json::from_str(&encoded).unwrap(), &mut prepared);
    assert_eq!(state.compacted_through, 2);
    assert_eq!(state.browser_prune.watermark, 3);
    assert_eq!(
        state.browser_prune.stripped, 0,
        "resume scans still files once"
    );
    let covered = state.messages[..2].to_vec();
    prune(
        &mut state.messages,
        &mut state.browser_prune,
        state.compacted_through,
        0,
    );
    assert_eq!(
        state.messages[..2],
        covered,
        "summary source digest stays valid"
    );
    assert!(is_superseded(&state.messages[2].content));
    assert!(!is_superseded(&state.messages[3].content));
    assert_eq!(state.browser_prune.stripped, state.messages.len());
    let once = state.messages.clone();
    call(&mut state.messages, "a", "a3", 1, 1);
    prune(
        &mut state.messages,
        &mut state.browser_prune,
        state.compacted_through,
        u64::MAX,
    );
    assert_eq!(state.messages[..once.len()], once);
    assert!(
        state
            .messages
            .iter()
            .all(|m| !m.content.contains("still_file"))
    );
    assert_eq!(state.browser_prune.stripped, state.messages.len());
    let legacy = State::resumed(
        AuthorityLoopContinuation::fixture("request", "call"),
        &mut prepared,
    );
    assert_eq!(legacy.compacted_through, 0);
    assert_eq!(legacy.browser_prune.watermark, 0);
}
