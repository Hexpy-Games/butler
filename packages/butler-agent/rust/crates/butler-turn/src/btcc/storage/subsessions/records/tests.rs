//! Persisted packet and dispatch format pins.
use super::*;

fn one_call_packet_decodes_without_parent_review() {
    let mut packet =
        serde_json::to_value(SubsessionPacket::fixture(ChildRole::Steward, "Delegate")).unwrap();
    packet["parent_work_ref"]
        .as_object_mut()
        .unwrap()
        .remove("review_revision_id");
    let decoded: SubsessionPacket = serde_json::from_value(packet.clone()).unwrap();
    assert_eq!(
        decoded.parent_work_ref.as_ref().unwrap().review_revision_id,
        None
    );
    assert_eq!(serde_json::to_value(decoded).unwrap(), packet);
}

fn steward() -> SubsessionPacket {
    let mut packet = SubsessionPacket::fixture(ChildRole::Steward, "Do it");
    packet.acceptance_criteria = vec!["check".into()];
    packet.task_or_plan_refs = vec!["plan".into()];
    packet.allowed_tools_and_effects = vec!["edit_file:workspace".into()];
    packet.mutation_scope = vec![".".into()];
    packet
}

/// Format pin: persisted BTCC records and receipts stay byte-stable across
/// versions: subsession packets, dispatch intents and outbox inputs,
/// delegation identities, stored authority continuations, write and edit
/// effect inputs and receipts, and transition payloads with changed files.
// test-category: format-pin
#[tokio::test]
async fn persisted_btcc_records_are_byte_stable() {
    steward_packet_is_byte_stable();
    one_call_packet_decodes_without_parent_review();
    worker_packet_is_byte_stable();
    dispatch_intent_is_byte_stable();
    outbox_inputs_are_byte_stable();
    super::super::completion::tests::assert_success_relay_format();
    crate::btcc::subsessions::delegation_identities_are_byte_stable();
    crate::btcc::agent_loop::tests::stored_authority_continuation_with_every_field_is_byte_stable();
    crate::btcc::effects::workspace_file::tests::write_effect_normalized_input_is_byte_stable();
    crate::btcc::effects::workspace_edit::tests::edit_input_prepared_edit_and_receipt_are_byte_stable().await;
    crate::btcc::turn::payload_body_with_changed_files_is_byte_stable();
}

fn steward_packet_is_byte_stable() {
    assert_eq!(
        serde_json::to_string(&steward()).unwrap(),
        r#"{"child_role":"steward","delegation_id":"delegation","task_id":"task","parent_session_id":"parent-session","parent_turn_id":"parent-turn","parent_chat_id":"parent-chat","relation_id":"relation","access_mode":"full_access","execution_mode":"mutation","objective":"Do it","acceptance_criteria":["check"],"task_or_plan_refs":["plan"],"constraints_and_non_goals":[],"allowed_tools_and_effects":["edit_file:workspace"],"mutation_scope":["."],"parent_work_ref":{"work_id":"work","session_id":"parent-session","turn_id":"parent-turn","plan_revision_id":"plan","review_revision_id":"review"},"model_ref":"provider/model","reasoning_effort":"medium"}"#
    );
}

fn worker_packet_is_byte_stable() {
    let mut packet = steward();
    packet.child_role = ChildRole::Worker;
    packet.source_tool_call_id = Some("call".into());
    packet.parent_chat_id = None;
    packet.implementation_brief = Some("brief".into());
    packet.plan_action = Some(PacketPlanAction {
        action_key: "a1".into(),
        description: "step".into(),
        dependency_keys: vec![],
    });
    packet.constraints_and_non_goals = vec!["bounded".into()];
    packet.worker_profile = Some(PacketWorkerProfile {
        prompt: None,
        id: "profile".into(),
        job: serde_json::json!({"kind":"code"}),
    });
    assert_eq!(
        serde_json::to_string(&packet).unwrap(),
        r#"{"child_role":"worker","delegation_id":"delegation","source_tool_call_id":"call","task_id":"task","parent_session_id":"parent-session","parent_turn_id":"parent-turn","relation_id":"relation","access_mode":"full_access","execution_mode":"mutation","objective":"Do it","acceptance_criteria":["check"],"implementation_brief":"brief","plan_action":{"action_key":"a1","description":"step","dependency_keys":[]},"task_or_plan_refs":["plan"],"constraints_and_non_goals":["bounded"],"allowed_tools_and_effects":["edit_file:workspace"],"mutation_scope":["."],"parent_work_ref":{"work_id":"work","session_id":"parent-session","turn_id":"parent-turn","plan_revision_id":"plan","review_revision_id":"review"},"worker_profile":{"id":"profile","job":{"kind":"code"}},"model_ref":"provider/model","reasoning_effort":"medium"}"#
    );
}

fn dispatch_intent_is_byte_stable() {
    let mut intent = DispatchIntent::fixture();
    intent.envelope.peer.parent_id = Some("parent".into());
    assert_eq!(
        serde_json::to_string(&intent).unwrap(),
        r#"{"envelope":{"eventId":"event","transport":"app","accountId":"local","peer":{"kind":"dm","id":"child","parentId":"parent"},"sender":{"id":"sender","displayName":"Sender"},"message":{"id":"message","text":"text","timestamp":"now"},"routingHints":{"sessionId":"child","turnId":"turn"},"nativeStewardContext":{"version":1,"role":"steward","projectName":"","workspacePath":"/tmp","modelRef":"provider/model","reasoningEffort":"medium"},"raw":{"source":"fixture"}},"metadata":{"source":"fixture"}}"#
    );
}

fn outbox_inputs_are_byte_stable() {
    let worker = ParentResultInput::StewardQueue(WorkerResultInput {
        text: "t".into(),
        model_ref: "m".into(),
        reasoning_effort: "r".into(),
        timestamp: "now".into(),
    });
    assert_eq!(
        serde_json::to_string(&worker).unwrap(),
        r#"{"route":"steward_queue","text":"t","model_ref":"m","reasoning_effort":"r","timestamp":"now"}"#
    );
    let steward = ParentResultInput::ButlerApp(Box::new(StewardResultInput {
        child_session_id: None,
        relation_id: "rel".into(),
        result_id: "res".into(),
        parent_session_id: "ps".into(),
        parent_turn_id: "pt".into(),
        parent_chat_id: "pc".into(),
        message_id: "msg".into(),
        safe_title: "Delegated result".into(),
        text: "t".into(),
        model_ref: "m".into(),
        reasoning_effort: "r".into(),
        access_mode: "a".into(),
        timestamp: "now".into(),
        schedule_run: None,
    }));
    assert_eq!(
        serde_json::to_string(&steward).unwrap(),
        r#"{"route":"butler_app","relation_id":"rel","result_id":"res","parent_session_id":"ps","parent_turn_id":"pt","parent_chat_id":"pc","message_id":"msg","safe_title":"Delegated result","text":"t","model_ref":"m","reasoning_effort":"r","access_mode":"a","timestamp":"now"}"#
    );
}
