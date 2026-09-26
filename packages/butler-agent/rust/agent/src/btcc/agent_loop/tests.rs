use std::sync::atomic::Ordering;

use serde_json::json;

use crate::btcc::{
    AgentLoop, AgentLoopError, ExecutionRoute, RuntimeFailure, SuspensionReason, TerminalOutcome,
};

use super::ProductionAgentLoop;
use super::continuation::AuthorityLoopContinuation;
use super::contracts::{AuthorityDecision, CandidateDisposition, ToolOutcome};
use super::guided_ports::GuidedPolicyDependencies;
use super::ports::ModelRoundError;
use super::test_data::{call, result, run, turn};
use super::test_support::Fixture;
use super::test_support::FixtureOperationFactory;

#[tokio::test]
async fn guided_constructor_runs_real_policy_and_scoped_progress() {
    let mut tool_round = result("", vec![call("guided-call", "read_file")], 0);
    tool_round.accepted_checkpoint.as_mut().unwrap().round_id = "btcc-model-round-0:retry:3".into();
    let mut final_round = result("guided", vec![], 1);
    final_round.accepted_checkpoint.as_mut().unwrap().round_id =
        "btcc-model-round-1:retry:3".into();
    let fixture = Fixture::new([tool_round, final_round]);
    let dependencies = GuidedPolicyDependencies {
        prompt: fixture.clone(),
        authority: fixture.clone(),
        context: fixture.clone(),
        tools: fixture.clone(),
        journal: fixture.clone(),
        work: fixture.clone(),
        verified_image_payload: None,
        stream_observer: None,
        identity_observer: None,
    };
    let agent = ProductionAgentLoop::guided(
        fixture.clone(),
        fixture.clone(),
        dependencies,
        None,
        std::sync::Arc::new(FixtureOperationFactory(fixture.clone())),
        fixture.clone(),
        std::sync::Arc::new(crate::btcc::GuidedContinuationBudgetFactory::new(
            None,
            std::sync::Arc::new(|| 0),
        )),
        Some(fixture.clone()),
    );
    let outcome = agent
        .run(
            &turn(None, "safe_fallback"),
            &super::test_data::claim(),
            3,
            fixture.as_ref(),
            &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(outcome.content, "guided");
    let events = fixture.events.lock().unwrap();
    assert!(
        events
            .iter()
            .any(|value| value == "progress:turn.iteration.started")
    );
    assert!(events.iter().any(|value| value == "progress:tool.started"));
    assert!(
        events
            .iter()
            .any(|value| value == "progress:tool.completed")
    );
    drop(events);
    let progress = fixture.progress_events.lock().unwrap();
    for phase in ["prompt", "context", "tool", "journal", "work"] {
        let event = progress
            .iter()
            .find(|event| event.kind == format!("test.guided.{phase}"))
            .unwrap_or_else(|| panic!("missing scoped callback progress for {phase}"));
        assert_eq!(
            event.payload.as_ref(),
            json!({
                "turnId": "turn-1",
                "claimId": "claim",
                "recoveryAttempt": 3,
                "cancelled": false,
            })
            .as_object()
        );
    }
}

#[tokio::test]
async fn recovery_attempt_is_part_of_model_round_identity() {
    let mut recovered = result("recovered", vec![], 0);
    recovered.accepted_checkpoint.as_mut().unwrap().round_id = "btcc-model-round-0:retry:2".into();
    let fixture = Fixture::new([recovered]);
    let agent = fixture.agent();
    let outcome = agent
        .run(
            &turn(None, "safe_fallback"),
            &super::test_data::claim(),
            2,
            fixture.as_ref(),
            &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(outcome.content, "recovered");
    assert!(
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|value| { value == "prepare:btcc-model-round-0:retry:2" })
    );
}

#[tokio::test]
async fn execution_policy_project_precedes_context_even_when_explicitly_empty() {
    for policy_project in ["policy-project", ""] {
        let fixture = Fixture::new([result("done", vec![], 0)]);
        let mut admitted = turn(None, "safe_fallback");
        admitted.context["projectRef"] = json!("context-project");
        admitted.context["executionPolicy"] = json!({
            "role":"worker",
            "accessMode":"full_access",
            "trackingMode":"none",
            "requiredNativeToolProfiles":[],
            "requiredNativeTools":[],
            "workspacePath":"/tmp/workspace",
            "projectId":policy_project
        });
        run(&fixture.agent(), &admitted).await.unwrap();
        assert_eq!(
            fixture.operation_scopes.lock().unwrap()[0]
                .project_ref
                .as_deref(),
            Some(policy_project)
        );
    }
}

#[tokio::test]
async fn scoped_tool_progress_projects_reference_and_chunk_without_raw_output() {
    let fixture = Fixture::new([
        result("", vec![call("one", "read_file")], 0),
        result("done", vec![], 1),
    ]);
    let agent = fixture.agent();
    agent
        .run(
            &turn(None, "safe_fallback"),
            &super::test_data::claim(),
            1,
            fixture.as_ref(),
            &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    let progress = fixture.progress_events.lock().unwrap();
    let completed = progress
        .iter()
        .find(|event| {
            event.kind == "tool.completed"
                && event
                    .payload
                    .as_ref()
                    .and_then(|value| value.get("toolCallId"))
                    == Some(&json!("one"))
        })
        .unwrap();
    let payload = completed.payload.as_ref().unwrap();
    assert!(payload.get("resultId").is_some());
    assert!(payload.get("resultJson").is_none());
    assert!(
        progress
            .iter()
            .any(|event| event.kind == "operation.output.chunk")
    );
}

#[tokio::test]
async fn direct_round_accepts_checkpoint_and_keeps_event_order_without_budget() {
    let fixture = Fixture::new([result("done", vec![], 0)]);
    let outcome = run(&fixture.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(outcome.route, ExecutionRoute::Direct);
    assert_eq!(outcome.content, "done");
    let events = fixture.events.lock().unwrap();
    let prepare = position(&events, "prepare:btcc-model-round-0");
    let accepted = position(&events, "accepted:btcc-model-round-0");
    let response = events
        .iter()
        .position(|value| value.contains("event:ModelResponse"))
        .unwrap();
    assert!(prepare < accepted && accepted < response);
    assert!(events.iter().any(|value| value.contains("event:ModelCall")));
    assert!(
        events
            .iter()
            .any(|value| value.contains("event:ModelResponse"))
    );
}

#[tokio::test]
async fn batches_use_concurrency_only_for_all_safe_calls_and_preserve_result_order() {
    let safe = Fixture::new([
        result(
            "",
            vec![call("one", "web_search"), call("two", "start_work")],
            0,
        ),
        result("reported", vec![], 1),
    ]);
    *safe.has_work.lock().unwrap() = true;
    let managed = run(&safe.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(managed.route, ExecutionRoute::Managed);
    assert!(
        safe.events
            .lock()
            .unwrap()
            .iter()
            .any(|value| value == "batch:one,two")
    );

    let sequential = Fixture::new([
        result("", vec![call("a", "read_file"), call("b", "web_search")], 0),
        result("reported", vec![], 1),
    ]);
    let assisted = run(&sequential.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(assisted.route, ExecutionRoute::Assisted);
    let events = sequential.events.lock().unwrap();
    assert!(position(&events, "execute:read_file") < position(&events, "execute:web_search"));
    assert!(events.iter().any(|value| value == "batch:a,b"));
}

#[tokio::test]
async fn steering_rebase_reselects_surface_before_the_model_request() {
    let fixture = Fixture::new([result("done", vec![], 0)]);
    *fixture.rebase_once.lock().unwrap() = true;
    fixture.steering.lock().unwrap().extend([
        vec![super::contracts::SteeringObservation {
            content: "initial direction".into(),
            request_segment_kind: "project_ledger_and_work_authority".into(),
        }],
        vec![super::contracts::SteeringObservation {
            content: "new user direction".into(),
            request_segment_kind: "current_user_request".into(),
        }],
    ]);
    run(&fixture.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    let events = fixture.events.lock().unwrap();
    let ordinary_surfaces = events
        .iter()
        .filter(|value| value.as_str() == "surface:ordinary")
        .count();
    assert_eq!(ordinary_surfaces, 2);
    assert!(
        events
            .iter()
            .any(|value| value.starts_with("model:") && value.contains("new user direction"))
    );
}

#[tokio::test]
async fn failed_model_releases_operation_results_and_preserves_operational_facts() {
    let fixture = Fixture::new([]);
    fixture
        .model_results
        .lock()
        .unwrap()
        .push_back(Err(ModelRoundError::Operational(RuntimeFailure {
            code: "provider_unavailable".into(),
            retryable: true,
        })));
    *fixture.has_work.lock().unwrap() = true;
    let outcome = run(&fixture.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(outcome.route, ExecutionRoute::Managed);
    assert_eq!(
        outcome.runtime_failure.unwrap().code,
        "provider_unavailable"
    );
    assert!(
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|value| value == "failed:btcc-model-round-0")
    );

    let integrity = Fixture::new([]);
    integrity
        .model_results
        .lock()
        .unwrap()
        .push_back(Err(ModelRoundError::Integrity(
            crate::btcc::BtccError::new("route_journal_failed", "route_journal_failed"),
        )));
    let error = run(&integrity.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap_err();
    assert!(
        matches!(error, AgentLoopError::Propagate(value) if value.code == "route_journal_failed")
    );
}

#[tokio::test]
async fn authority_snapshot_roundtrips_and_resumes_allow_deny_and_modify() {
    let pending = Fixture::new([result("", vec![call("pending", "read_file")], 0)]);
    pending.tool_outputs.lock().unwrap().insert(
        "pending".into(),
        json!({"authority_pending":true,"request_ref":"request-1"}),
    );
    let pending_agent = pending.guided_agent(None);
    let suspended = run(&pending_agent, &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(
        suspended.suspension,
        Some(SuspensionReason::AuthorityPending)
    );
    let continuation = suspended.authority_continuation.unwrap();
    let decoded: AuthorityLoopContinuation = serde_json::from_value(continuation.clone()).unwrap();
    assert_eq!(decoded.request_ref, "request-1");
    assert_eq!(decoded.call_id, "journal-pending");
    assert_eq!(decoded.batch.next_call_index, 0);
    assert!(
        decoded
            .messages
            .iter()
            .all(|message| message.continuation_item_id.is_some())
    );
    let encoded = serde_json::to_string(&decoded).unwrap();
    assert!(encoded.contains("continuationItemId"));
    assert!(!encoded.contains(":null"));
    assert_eq!(serde_json::to_value(decoded).unwrap(), continuation);

    for decision in [
        AuthorityDecision::Allow,
        AuthorityDecision::Deny,
        AuthorityDecision::Modify {
            input: "use another approach".into(),
        },
    ] {
        let fixture = Fixture::new([result("resumed", vec![], 1)]);
        let agent = fixture.guided_agent(Some(decision.clone()));
        let outcome = run(&agent, &turn(Some(continuation.clone()), "safe_fallback"))
            .await
            .unwrap();
        assert_eq!(outcome.content, "resumed");
        let events = fixture.events.lock().unwrap();
        match decision {
            AuthorityDecision::Allow => {
                assert!(events.iter().any(|value| value == "execute:read_file"))
            }
            AuthorityDecision::Deny => {
                assert!(events.iter().any(|value| value == "unexecuted:pending"))
            }
            AuthorityDecision::Modify { .. } => {
                assert!(events.iter().any(|value| value == "unexecuted:pending"));
                assert!(
                    events.iter().any(|value| value.starts_with("model:")
                        && value.contains("use another approach"))
                );
            }
        }
    }
}

#[tokio::test]
async fn waiting_no_visible_empty_recovery_and_first_effective_outcome_are_preserved() {
    let waiting = Fixture::new([result("candidate", vec![], 0)]);
    waiting
        .candidates
        .lock()
        .unwrap()
        .push_back(CandidateDisposition::Wait);
    let outcome = run(&waiting.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(outcome.suspension, Some(SuspensionReason::WaitingForWorker));

    let empty = Fixture::new([result("", vec![], 0), result("", vec![], 1)]);
    let no_visible = run(&empty.agent(), &turn(None, "typed_terminal"))
        .await
        .unwrap();
    assert_eq!(
        no_visible.terminal_outcome,
        Some(TerminalOutcome::NoVisible)
    );
    assert_eq!(
        empty
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|value| value.starts_with("model:"))
            .count(),
        2
    );

    let first = Fixture::new([result(
        "",
        vec![call("one", "web_search"), call("two", "start_work")],
        0,
    )]);
    first
        .outcomes
        .lock()
        .unwrap()
        .insert("one".into(), ToolOutcome::Reply("first reply".into()));
    first
        .outcomes
        .lock()
        .unwrap()
        .insert("two".into(), ToolOutcome::Reply("second reply".into()));
    let outcome = run(&first.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap();
    assert_eq!(outcome.content, "first reply");
    assert!(
        !first
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|value| value == "batch:one,two")
    );
}

#[tokio::test]
async fn cancelled_tool_io_and_integrity_failures_propagate() {
    let fixture = Fixture::new([result("", vec![call("one", "read_file")], 0)]);
    fixture.cancel_during_model.store(true, Ordering::SeqCst);
    let error = run(&fixture.agent(), &turn(None, "safe_fallback"))
        .await
        .unwrap_err();
    assert!(matches!(error, AgentLoopError::Propagate(value) if value.code == "turn_cancelled"));
}

fn position(events: &[String], exact: &str) -> usize {
    events.iter().position(|value| value == exact).unwrap()
}

#[tokio::test]
async fn response_payload_reaches_observers_history_and_next_round() {
    let continuation = json!({"provider":"openai","statelessInput":[{"opaque":"retained"}]});
    let raw = json!({"vendor":{"unknown":[1,"kept"]}});
    let mut first = result("working", vec![call("owned", "read_file")], 0);
    first.continuation = Some(continuation.clone());
    first.raw = Some(raw.clone());
    let fixture = Fixture::new([first, result("done", vec![], 1)]);
    assert_eq!(
        run(&fixture.agent(), &turn(None, "safe_fallback"))
            .await
            .unwrap()
            .content,
        "done"
    );
    let views = fixture.continuation_views.lock().unwrap();
    assert_eq!(views[0], ("request", None));
    for (index, phase) in [(1, "accepted"), (2, "request")] {
        assert_eq!(views[index], (phase, Some(continuation.clone())));
    }
    let history = fixture.request_history.lock().unwrap();
    let assistant = history[1]
        .iter()
        .find(|message| message.role == super::contracts::ModelRoundRole::Assistant)
        .unwrap();
    assert_eq!(assistant.content.as_ref(), "working");
    assert_eq!(assistant.tool_calls.as_ref().unwrap()[0].id, "owned");
    assert_eq!(assistant.provider_data, Some(raw));
}
