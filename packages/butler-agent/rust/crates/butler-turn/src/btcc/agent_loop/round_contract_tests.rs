use super::contracts::{BatchDisposition, ToolChoice, UsageAttribution};
use super::test_data::{call, result, run, tool, turn};
use super::test_support::Fixture;

// test-category: pure-logic
#[tokio::test]
async fn round_attribution_uses_source_offset_and_final_report_runs_only_answer_blocks() {
    let fixture = Fixture::new([
        result("", vec![call("one", "read_file")], 0),
        result("", vec![call("blocks", "answer_blocks")], 1),
        result("", vec![call("late", "read_file")], 2),
        result("settled", vec![], 3),
    ]);
    fixture
        .reply_tools
        .lock()
        .unwrap()
        .push(tool("answer_blocks", false));
    *fixture.usage_attribution.lock().unwrap() = Some(UsageAttribution {
        usage_root: None,
        usage_role: None,
        prompt_diagnostics: None,
        session_kind: Some("parent".into()),
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
        vec![
            (Some(ToolChoice::Auto), Some(7)),
            (Some(ToolChoice::Auto), Some(8)),
            (Some(ToolChoice::Auto), Some(9)),
            (Some(ToolChoice::Auto), Some(10))
        ]
    );
    // The report may still show its answer blocks; other tools stay closed.
    let events = fixture.events.lock().unwrap().clone();
    assert!(
        events.contains(&"execute:answer_blocks".to_owned()),
        "{events:?}"
    );
    assert!(
        !events.contains(&"unexecuted:blocks".to_owned()),
        "{events:?}"
    );
    assert!(events.contains(&"unexecuted:late".to_owned()), "{events:?}");
}
