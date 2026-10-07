//! Batch outcome ordering, including authority continuation recovery.
use super::contracts::{AuthorityDecision, ToolOutcome};
use super::test_data::{call, result, run, turn};
use super::test_support::Fixture;
use crate::btcc::{AgentLoopError, SuspensionReason};
use serde_json::json;

// test-category: pure-logic
#[tokio::test]
async fn no_visible_empty_recovery_and_first_effective_outcome_are_preserved() {
    let empty = Fixture::new([
        result("", vec![], 0),
        result("", vec![], 1),
        result("recovered", vec![], 2),
    ]);
    let no_visible = run(&empty.agent(), &turn(None, "typed_terminal"))
        .await
        .unwrap();
    assert_eq!(no_visible.terminal_outcome, None);
    assert_eq!(no_visible.content, "recovered");
    assert_eq!(
        empty
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|value| value.starts_with("model:"))
            .count(),
        3
    );

    let first = Fixture::new([result(
        "",
        vec![call("one", "web_search"), call("two", "start_work")],
        0,
    )]);
    first.outcomes.lock().unwrap().insert(
        "one".into(),
        ToolOutcome::Suspend(SuspensionReason::WaitingForWorker),
    );
    first.outcomes.lock().unwrap().insert(
        "two".into(),
        ToolOutcome::Suspend(SuspensionReason::AuthorityPending),
    );
    let outcome = run(&first.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(outcome.suspension, Some(SuspensionReason::WaitingForWorker));
    assert!(
        !first
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|value| value == "batch:one,two")
    );
    // A settled sibling before or after the parked call retains the first outcome.
    for pending_first in [false, true] {
        let calls = if pending_first {
            vec![call("pending", "web_search"), call("settled", "start_work")]
        } else {
            vec![call("settled", "start_work"), call("pending", "web_search")]
        };
        let fixture = Fixture::new([result("", calls, 0)]);
        fixture.tool_outputs.lock().unwrap().insert(
            "pending".into(),
            json!({"authority_pending": true, "request_ref": "request-1"}),
        );
        fixture.outcomes.lock().unwrap().insert(
            "settled".into(),
            ToolOutcome::Suspend(SuspensionReason::WaitingForWorker),
        );
        if !pending_first {
            fixture.outcomes.lock().unwrap().insert(
                "pending".into(),
                ToolOutcome::Suspend(SuspensionReason::AuthorityPending),
            );
        }
        let suspended = run(&fixture.agent(), &turn(None, "safe_fallback"))
            .await
            .unwrap();
        let continuation = suspended.authority_continuation.unwrap();
        assert_eq!(
            continuation.batch.first_suspension,
            (!pending_first).then_some(SuspensionReason::WaitingForWorker)
        );
        let resumed = Fixture::new([]);
        *resumed.outcomes.lock().unwrap() = fixture.outcomes.lock().unwrap().clone();
        let outcome = run(
            &resumed.guided_agent(Some(AuthorityDecision::Allow)),
            &turn(Some(continuation), "safe_fallback"),
        )
        .await
        .unwrap();
        assert_eq!(outcome.suspension, Some(SuspensionReason::WaitingForWorker));
        assert!(resumed.request_history.lock().unwrap().is_empty());
        let events = resumed.events.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|value| value.contains("ToolResult") && value.contains("pending"))
        );
        if pending_first {
            assert!(
                events
                    .iter()
                    .any(|value| value.contains("ToolResult") && value.contains("settled"))
            );
        }
    }

    let malformed = Fixture::new([result("", vec![call("missing", "read_file")], 0)]);
    malformed.outcomes.lock().unwrap().insert(
        "missing".into(),
        ToolOutcome::Suspend(SuspensionReason::AuthorityPending),
    );
    let failure = run(&malformed.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap_err();
    let AgentLoopError::Propagate(failure) = failure else {
        panic!("expected a typed contract error");
    };
    assert_eq!(failure.code(), "authority_continuation_missing");
}
