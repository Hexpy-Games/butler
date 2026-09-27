use super::contracts::{BatchDisposition, ToolChoice, UsageAttribution};
use super::test_data::{call, result, run, turn};
use super::test_support::Fixture;

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
