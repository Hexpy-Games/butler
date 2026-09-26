use super::contracts::{BatchDisposition, ToolChoice, UsageAttribution};
use super::test_data::{call, result, run, turn};
use super::test_support::Fixture;

#[test]
fn message_wire_keeps_absent_and_explicit_empty_tool_calls_distinct() {
    let user = super::contracts::ModelRoundMessage::user("hello".into(), None);
    let assistant = super::state::assistant_message("done".into(), vec![], None);
    assert!(
        serde_json::to_value(user)
            .unwrap()
            .get("toolCalls")
            .is_none()
    );
    assert_eq!(
        serde_json::to_value(assistant).unwrap()["toolCalls"],
        serde_json::json!([])
    );
}

#[tokio::test]
async fn round_attribution_uses_source_offset_and_final_report_omits_tool_choice() {
    let fixture = Fixture::new([
        result("", vec![call("one", "read_file")], 0),
        result("settled", vec![], 1),
    ]);
    *fixture.usage_attribution.lock().unwrap() = Some(UsageAttribution {
        turn_id: "turn-1".into(),
        phase: "ordinary".into(),
        reasoning_effort: None,
        round_index: Some(7),
    });
    fixture
        .batches
        .lock()
        .unwrap()
        .push_back(BatchDisposition::FinalReport);
    run(&fixture.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(
        *fixture.request_contracts.lock().unwrap(),
        vec![(Some(ToolChoice::Auto), Some(7)), (None, Some(8))]
    );
}

#[test]
fn cloned_model_message_shares_and_releases_large_content() {
    let message = super::contracts::ModelRoundMessage::user("x".repeat(1_000_000), None);
    let weak = std::sync::Arc::downgrade(&message.content);
    let projection = message.clone();
    assert!(std::sync::Arc::ptr_eq(
        &message.content,
        &projection.content
    ));
    drop(message);
    assert!(weak.upgrade().is_some());
    drop(projection);
    assert!(weak.upgrade().is_none());
}
