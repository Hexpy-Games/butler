use std::sync::Arc;

use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::ContextSizingRequest;
use super::test_support::*;
use crate::btcc::agent_loop::ModelRoundError;
use crate::btcc::{BtccError, ReasoningEffort};

mod contract_tests;

#[tokio::test]
async fn accepted_replay_skips_provider_and_forwards_sizing() {
    let store = Arc::new(Store::default());
    store
        .accepted
        .lock()
        .unwrap()
        .push_back(Some(serde_json::to_value(result("cached")).unwrap()));
    let base = Base::new([]);
    let turn = turn(route(0, 2));
    let claim = claim();
    let progress = Progress::default();
    let execution = make_execution(
        store,
        &base,
        &turn,
        &claim,
        &progress,
        CancellationToken::new(),
    )
    .await;
    let messages = [message("hello")];
    let reasoning = ReasoningEffort::High;
    let result = execution
        .routed()
        .run_round(request(
            "round-1",
            &messages,
            &reasoning,
            CancellationToken::new(),
        ))
        .await
        .unwrap();
    assert_eq!(result.text.as_deref(), Some("cached"));
    assert!(base.models.lock().unwrap().is_empty());
    assert_eq!(
        execution
            .routed()
            .initial_request_bytes("p", "i", None)
            .unwrap(),
        Some(11)
    );
    assert_eq!(
        execution
            .routed()
            .stateless_message_bytes(&messages, None)
            .unwrap(),
        Some(5)
    );
    let sizing = execution
        .routed()
        .context_sizing(ContextSizingRequest {
            model: "openai/a",
            instructions: None,
            tools: &[],
            attachments: &[],
            max_output_tokens: None,
            butler_data: None,
        })
        .unwrap()
        .unwrap();
    assert_eq!((sizing.measure)(&messages).unwrap(), 3.5);
    assert_eq!(sizing.max_output_tokens, Some(7.5));
    assert_eq!(sizing.max_message_bytes, 99.25);
}

#[tokio::test]
async fn fallback_cursor_is_execution_local_and_persists_across_rounds() {
    let store = Arc::new(Store::default());
    let base = Base::new([
        Err(provider("provider_model_not_found", Some(404))),
        Ok(result("fallback-one")),
        Ok(result("fallback-two")),
    ]);
    let first_turn = turn(route(0, 1));
    let first_claim = claim();
    let first_progress = Progress::default();
    let first = make_execution(
        store.clone(),
        &base,
        &first_turn,
        &first_claim,
        &first_progress,
        CancellationToken::new(),
    )
    .await;
    let second_base = Base::new([Ok(result("independent"))]);
    let second_turn = turn(route(0, 1));
    let second_claim = claim();
    let second_progress = Progress::default();
    let second = make_execution(
        store.clone(),
        &second_base,
        &second_turn,
        &second_claim,
        &second_progress,
        CancellationToken::new(),
    )
    .await;
    let (first_result, second_result) =
        tokio::join!(run(&*first, "round-1"), run(&*second, "round-3"));
    first_result.unwrap();
    second_result.unwrap();
    run(&*first, "round-2").await.unwrap();
    assert_eq!(
        &*base.models.lock().unwrap(),
        &["openai/a", "openai/b", "openai/b"]
    );
    assert_eq!(
        &*base.attempts.lock().unwrap(),
        &[Some(1.0), Some(1.0), Some(1.0)]
    );
    assert_eq!(first.active_model_ref(), "openai/b");
    assert_eq!(first.selected_reasoning_effort(), ReasoningEffort::High);
    assert_eq!(
        first.accepted_model_identity().unwrap().effective_model_ref,
        "openai/b"
    );
    assert_eq!(&*second_base.models.lock().unwrap(), &["openai/a"]);
    assert_eq!(second.active_model_ref(), "openai/a");
}

#[tokio::test]
async fn fallback_projection_waits_for_persisted_start_and_shares_source_revision() {
    let store = Arc::new(Store::default());
    let base = Base::new([
        Err(provider("provider_model_not_found", None)),
        Ok(result("fallback")),
    ]);
    let mut turn = turn(route(0, 1));
    turn.authority_continuation = Some(json!({"presentation":{"sourceRevision":7}}));
    let claim = claim();
    let progress = Progress::default();
    let execution = make_execution(
        store,
        &base,
        &turn,
        &claim,
        &progress,
        CancellationToken::new(),
    )
    .await;
    run(&*execution, "projection").await.unwrap();
    let events = progress.events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        [
            "assistant.public_note",
            "turn.iteration.started",
            "tool.started"
        ]
    );
    let fallback = events[0].payload.as_ref().unwrap();
    assert_eq!(fallback["sourceRevision"], 8);
    assert_eq!(fallback["model"], "openai/b");
    assert_eq!(fallback["btccState"], "admitted");
    assert_eq!(
        events[1].payload.as_ref().unwrap()["requestId"],
        "projection"
    );
}

#[tokio::test]
async fn recovery_projection_clears_only_after_active_wait() {
    let store = Arc::new(Store::default());
    let base = Base::new([
        Err(provider("provider_network_error", None)),
        Ok(result("recovered")),
    ]);
    let turn = turn(route(0, 2));
    let claim = claim();
    let progress = Progress::default();
    let execution = make_execution(
        store,
        &base,
        &turn,
        &claim,
        &progress,
        CancellationToken::new(),
    )
    .await;
    run(&*execution, "recovery").await.unwrap();
    let events = progress.events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0].payload.as_ref().unwrap()["recoveryStatus"],
        "recovering"
    );
    assert_eq!(
        events[1].payload.as_ref().unwrap()["recoveryStatus"],
        "cleared"
    );
}

#[tokio::test]
async fn absent_round_ids_use_execution_local_sequence_without_collapsing_empty() {
    let store = Arc::new(Store::default());
    let base = Base::new([Ok(result("generated")), Ok(result("empty"))]);
    let turn = turn(route(0, 1));
    let claim = claim();
    let progress = Progress::default();
    let execution = make_execution(
        store.clone(),
        &base,
        &turn,
        &claim,
        &progress,
        CancellationToken::new(),
    )
    .await;
    let messages = [message("hello")];
    let reasoning = ReasoningEffort::High;
    let mut generated = request("ignored", &messages, &reasoning, CancellationToken::new());
    generated.round_id = None;
    execution.routed().run_round(generated).await.unwrap();
    let explicit_empty = request("", &messages, &reasoning, CancellationToken::new());
    execution.routed().run_round(explicit_empty).await.unwrap();
    let rounds = store
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "model.attempt.started")
        .map(|event| event["roundId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(rounds, ["turn:round:0", ""]);
}

#[tokio::test]
async fn restart_abandons_open_slot_before_dispatch() {
    let store = Arc::new(Store::default());
    store
        .histories
        .lock()
        .unwrap()
        .push_back(json!({"started":[1],"failed":[],"succeeded":[],"abandoned":[]}));
    let base = Base::new([Ok(result("recovered"))]);
    let turn = turn(route(0, 2));
    let claim = claim();
    let progress = Progress::default();
    let execution = make_execution(
        store.clone(),
        &base,
        &turn,
        &claim,
        &progress,
        CancellationToken::new(),
    )
    .await;
    run(&*execution, "round-restart").await.unwrap();
    let kinds = store
        .events
        .lock()
        .unwrap()
        .iter()
        .map(|v| v["type"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        &kinds[..2],
        &[
            "model.attempt.abandoned_after_restart",
            "model.attempt.started"
        ]
    );
}

#[tokio::test]
async fn durability_failure_prevents_provider_dispatch() {
    let store = Arc::new(Store::default());
    *store.fail_read.lock().unwrap() = Some(BtccError::relayed("model_checkpoint_stale", "stale"));
    let base = Base::new([Ok(result("must-not-run"))]);
    let turn = turn(route(0, 1));
    let claim = claim();
    let progress = Progress::default();
    let execution = make_execution(
        store,
        &base,
        &turn,
        &claim,
        &progress,
        CancellationToken::new(),
    )
    .await;
    let error = run(&*execution, "round-stale").await.unwrap_err();
    assert!(
        matches!(error, ModelRoundError::Integrity(ref value) if value.code() == "model_route_durability_failure")
    );
    assert!(base.models.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dispatches_never_exceed_validated_route_budget() {
    let store = Arc::new(Store::default());
    let failures = (0..30).map(|_| Err(provider("provider_network_error", None)));
    let base = Base::new(failures);
    let candidates = (0..6)
        .map(|index| json!({"modelRef":format!("openai/model-{index}"),"reasoningEffort":"medium"}))
        .collect::<Vec<_>>();
    let route = json!({
        "schemaVersion":"butler.model-route.v1",
        "routeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "candidates":candidates,
        "retryCeiling":5,
        "catalogGeneration":"test",
        "activeCursor":0,
        "consumedAttempts":[]
    });
    let turn = turn(route);
    let claim = claim();
    let progress = Progress::default();
    let execution = make_execution(
        store,
        &base,
        &turn,
        &claim,
        &progress,
        CancellationToken::new(),
    )
    .await;
    assert!(matches!(
        run(&*execution, "bounded").await,
        Err(ModelRoundError::Operational(_))
    ));
    assert_eq!(base.models.lock().unwrap().len(), 30);
    assert!(
        base.attempts
            .lock()
            .unwrap()
            .iter()
            .all(|attempt| *attempt == Some(1.0))
    );
}

#[tokio::test]
async fn physical_and_backoff_cancellation_keep_source_journal_distinction() {
    let store = Arc::new(Store::default());
    let physical = Base::new([Err(ModelRoundError::Cancelled)]);
    let physical_turn = turn(route(0, 1));
    let physical_claim = claim();
    let physical_progress = Progress::default();
    let physical_execution = make_execution(
        store.clone(),
        &physical,
        &physical_turn,
        &physical_claim,
        &physical_progress,
        CancellationToken::new(),
    )
    .await;
    assert!(matches!(
        run(&*physical_execution, "physical-cancel").await,
        Err(ModelRoundError::Operational(_))
    ));
    assert_eq!(failed_codes(&store), vec!["provider_unknown_error"]);

    let store = Arc::new(Store::default());
    let token = CancellationToken::new();
    token.cancel();
    let backoff = Base::new([Err(provider("provider_network_error", None))]);
    let backoff_turn = turn(route(0, 2));
    let backoff_claim = claim();
    let backoff_progress = Progress::default();
    let backoff_execution = make_execution(
        store.clone(),
        &backoff,
        &backoff_turn,
        &backoff_claim,
        &backoff_progress,
        token,
    )
    .await;
    assert!(matches!(
        run(&*backoff_execution, "backoff-cancel").await,
        Err(ModelRoundError::Cancelled)
    ));
    assert_eq!(failed_codes(&store), vec!["provider_network_error"]);
}
