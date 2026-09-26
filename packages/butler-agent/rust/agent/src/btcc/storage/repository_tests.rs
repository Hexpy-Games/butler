use serde_json::json;

use super::repository::BtccRepositories;
use super::tests::Fixture;
use super::*;
use crate::btcc::continuation_budget::TurnContinuationBudgetLimits;
use crate::btcc::{
    CanonicalMessageStore, ContentRef, DeliveryOutbox, DeliveryStatus, ExecutionRoute,
    FinalDisposition, FinalPayload, ModelRouteWrite, Peer, PeerKind, PreparedTurn, Sender,
    SessionRole, StopPersistenceOutcome, TurnMessage, TurnRequest, TurnRoute, TurnSemanticState,
    TurnStore, TurnTransition, TurnTrigger,
};

#[tokio::test]
async fn repository_admission_replay_claim_and_pre_admission_stop_are_durable() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("repository-admission"))
        .await
        .expect("open repository storage");
    let repositories = BtccRepositories::new(storage, None);

    assert_eq!(
        TurnStore::stop(&repositories, "turn-stopped")
            .await
            .expect("install pre-admission stop"),
        StopPersistenceOutcome::Cancelled
    );
    let stopped = prepared("turn-stopped", "trigger-stopped", "hash-stopped");
    let (turn, fresh) = repositories
        .load_or_admit(&stopped)
        .await
        .expect("construct stopped admission");
    assert!(fresh);
    assert_eq!(turn.semantic_state, TurnSemanticState::Cancelled);
    assert_eq!(turn.execution_fence, 1);

    let ordinary = prepared("turn-1", "trigger-1", "hash-1");
    let (turn, fresh) = repositories
        .load_or_admit(&ordinary)
        .await
        .expect("admit turn");
    assert!(fresh);
    assert_eq!(turn.semantic_state, TurnSemanticState::Admitted);
    let claim = repositories
        .acquire_state_claim(&turn)
        .await
        .expect("claim turn");
    assert_eq!(claim.turn_revision, 0);
    let (replayed, fresh) = repositories
        .load_or_admit(&ordinary)
        .await
        .expect("same replay");
    assert!(!fresh);
    assert_eq!(replayed.turn_id, turn.turn_id);

    let mut conflict = ordinary.clone();
    conflict.command["message"]["content"] = json!("different");
    let error = repositories
        .load_or_admit(&conflict)
        .await
        .expect_err("conflicting replay must fail");
    assert_eq!(error.code, "turn_replay_conflict");

    // JSON.stringify(undefined) differs from JSON.stringify(null) in the
    // legacy replay authority. An absent field must not become explicit null.
    let mut null_content = prepared("turn-null", "trigger-null", "hash-null");
    null_content.command["context"]["messageContent"] = json!(null);
    repositories.load_or_admit(&null_content).await.unwrap();
    let mut absent_content = null_content.clone();
    absent_content.command["context"]
        .as_object_mut()
        .unwrap()
        .shift_remove("messageContent");
    assert_eq!(
        repositories
            .load_or_admit(&absent_content)
            .await
            .unwrap_err()
            .code,
        "turn_replay_conflict"
    );
    assert!(!repositories.load_or_admit(&null_content).await.unwrap().1);

    let mut wake = prepared("turn-wake", "trigger-wake", "hash-wake");
    wake.request.trigger = TurnTrigger::AuthorizedWake {
        trigger_id: "wake-id".into(),
        source_turn_id: "source-turn".into(),
        authorization_ref: "authority-ref".into(),
        result_scope_ref: Some("result-scope".into()),
    };
    wake.command = json!({
        "kind":"wake","turnId":"turn-wake","sessionId":"session-1",
        "triggerKey":"trigger-wake","trigger":{"triggerId":"wake-id",
        "sourceTurnId":"source-turn","authorizationRef":"authority-ref",
        "resultScopeRef":"result-scope","content":"worker complete"},
        "modelSelection":{"provider":"openai","model":"gpt","reasoningEffort":"medium",
        "contextWindowTokens":100},"context":{"messageContent":"worker complete"}
    });
    let (woken, fresh) = repositories.load_or_admit(&wake).await.expect("admit wake");
    assert!(fresh);
    let wake_identity = woken.wake_identity.expect("full wake identity");
    assert_eq!(wake_identity.trigger_id, "wake-id");
    assert_eq!(wake_identity.source_turn_id, "source-turn");
    assert_eq!(wake_identity.authorization_ref, "authority-ref");
    assert_eq!(
        wake_identity.result_scope_ref.as_deref(),
        Some("result-scope")
    );
    repositories.close().await.expect("close repository");
}

#[tokio::test]
async fn model_journal_abandons_restarted_attempt_and_budget_terminal_commits() {
    let fixture = Fixture::activated();
    let limits = TurnContinuationBudgetLimits {
        max_model_requests: 2,
        max_tool_rounds: 2,
        max_model_facing_bytes: 10,
        max_cumulative_model_facing_bytes: 10,
        max_output_bytes: 3,
        max_elapsed_ms: 10_000,
        max_idle_ms: 10_000,
        extensions: Default::default(),
    };
    let storage = BtccStorage::open(fixture.config("repository-model"))
        .await
        .expect("open repository storage");
    let repositories = BtccRepositories::new(storage, Some(limits));
    let prepared = prepared("turn-model", "trigger-model", "hash-model");
    let (turn, _) = repositories
        .load_or_admit(&prepared)
        .await
        .expect("admit model turn");
    let claim = repositories
        .acquire_state_claim(&turn)
        .await
        .expect("claim model turn");
    let route = json!({"routeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","activeCursor":0,"candidates":[{"modelRef":"openai/gpt"}]});
    let binding = ModelRouteWrite {
        turn_id: turn.turn_id.clone(),
        expected_revision: turn.revision,
        execution_fence: turn.execution_fence,
        claim_id: claim.claim_id.clone(),
        route,
    };
    let event = crate::btcc::ModelRouteEventWrite {
        binding: binding.clone(),
        event: json!({"type":"model.attempt.started","roundId":"round-1","candidateIndex":0,"transportAttempt":1,"modelRef":"openai/gpt"}),
    };
    assert_eq!(
        repositories
            .record_model_route_event(event.clone())
            .await
            .expect("record start"),
        Some(json!({"status":"recorded"}))
    );
    assert_eq!(
        repositories
            .record_model_route_event(event)
            .await
            .expect("replay start"),
        Some(json!({"status":"abandoned_after_restart"}))
    );
    let checkpoint = turn.checkpoint.as_ref().expect("checkpoint");
    let key = crate::btcc::ModelRoundKey {
        turn_id: turn.turn_id.clone(),
        round_id: "round-1".into(),
        route_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        candidate_index: 0,
        model_ref: "openai/gpt".into(),
        checkpoint_id: Some(checkpoint.checkpoint_id.clone()),
        checkpoint_revision: Some(checkpoint.checkpoint_revision),
    };
    let history = repositories
        .load_model_route_attempt_history(key.clone())
        .await
        .expect("load model route history");
    assert_eq!(history["started"], json!([1]));
    assert_eq!(history["abandoned"], json!([1]));
    repositories.record_model_round_acceptance(crate::btcc::ModelRoundAcceptanceWrite {
        binding: binding.clone(), key: key.clone(), transport_attempt: 2,
        result: json!({"toolCalls":[],"assistantMessage":{"role":"assistant","content":"ok",
            "providerData":{"private":"drop"}},"continuation":{"provider":"openai",
            "responseId":"response-1","deliveredThroughOrdinal":0},
            "providerIdentity":{"provider":"openai","configuredModel":"gpt","reportedModel":"gpt"}}),
    }).await.expect("accept model round");
    let accepted = repositories
        .load_model_round_acceptance(key.clone())
        .await
        .expect("load acceptance")
        .expect("accepted round");
    assert!(accepted["assistantMessage"].get("providerData").is_none());
    let mut stale = key;
    stale.checkpoint_revision = Some(99);
    assert_eq!(
        repositories
            .load_model_round_acceptance(stale)
            .await
            .expect_err("stale checkpoint rejected")
            .code,
        "model_checkpoint_stale"
    );

    let now = turn.continuation_budget.as_ref().expect("budget")["startedAtMs"]
        .as_u64()
        .expect("start time");
    let error = repositories
        .transition_continuation_budget(crate::btcc::ContinuationBudgetTransition {
            binding,
            event: json!({"kind":"record_output","roundId":"round-1","outputBytes":4}),
            now_ms: now + 1,
        })
        .await
        .expect_err("output limit must exhaust");
    assert_eq!(error.code, "turn_continuation_budget_exhausted");
    let persisted = repositories
        .find_turn("turn-model")
        .await
        .expect("load turn")
        .expect("turn");
    assert_eq!(
        persisted.continuation_budget.expect("budget")["terminal"]["reason"],
        "max_output_bytes"
    );
    repositories.close().await.expect("close repository");
}

#[tokio::test]
async fn stop_cancels_turn_claim_and_same_session_authority_atomically() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("repository-stop"))
        .await
        .expect("open repository storage");
    let repositories = BtccRepositories::new(storage, None);
    let (turn, _) = repositories
        .load_or_admit(&prepared("turn-stop", "trigger-stop", "hash-stop"))
        .await
        .expect("admit turn");
    let claim = repositories
        .acquire_state_claim(&turn)
        .await
        .expect("claim turn");
    repositories
        .storage
        .execute(|db| {
            db.execute(
                "INSERT INTO btcc_authority_requests (request_id,request_ref,identity_sha256,
            owner_session_id,source_session_id,source_turn_id,source_work_id,workspace_path,
            plan_revision_id,action_key,authority_generation,capability,normalized_target,
            normalized_input_json,model_ref,reasoning_effort,category,reason,executable,
            command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,
            outcome,created_at,updated_at) VALUES ('request-1','ref-1','identity-1','session-1',
            'session-1','turn-stop','work-1','/tmp','plan-1','action-1',1,'shell','target','{}',
            'openai/gpt','medium','command','reason','echo',1,'pending','once','schedule-1',
            'input','pending','now','now')",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .expect("seed authority request");

    assert_eq!(
        repositories.stop("turn-stop").await.expect("stop turn"),
        StopPersistenceOutcome::Cancelled
    );
    let facts = repositories.storage.execute(move |db| {
        let state:String=db.query_row("SELECT semantic_state FROM btcc_turns WHERE turn_id='turn-stop'",[],|r|r.get(0)).map_err(StorageError::sqlite)?;
        let claim_status:String=db.query_row("SELECT status FROM btcc_state_claims WHERE claim_id=?1",[claim.claim_id],|r|r.get(0)).map_err(StorageError::sqlite)?;
        let authority:(Option<String>,Option<String>)=db.query_row("SELECT close_reason,close_scope FROM btcc_authority_requests WHERE request_id='request-1'",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(StorageError::sqlite)?;
        Ok((state,claim_status,authority))
    }).await.expect("inspect atomic stop");
    assert_eq!(facts.0, "cancelled");
    assert_eq!(facts.1, "revoked");
    assert_eq!(
        facts.2,
        (
            Some("session_cancelled".into()),
            Some("self_session".into())
        )
    );
    repositories.close().await.expect("close repository");
}

#[tokio::test]
async fn final_outbox_canonical_insert_and_observation_use_separate_transactions() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("repository-delivery"))
        .await
        .expect("open repository storage");
    let repositories = BtccRepositories::new(storage, None);
    let (turn, _) = repositories
        .load_or_admit(&prepared(
            "turn-delivery",
            "trigger-delivery",
            "hash-delivery",
        ))
        .await
        .expect("admit delivery turn");
    let claim = repositories
        .acquire_state_claim(&turn)
        .await
        .expect("claim admitted");
    let reference = ContentRef {
        id: "payload-1".into(),
        sha256: "payload-sha".into(),
    };
    let payload = FinalPayload {
        reference: reference.clone(),
        turn_id: turn.turn_id.clone(),
        route: ExecutionRoute::Direct,
        disposition: FinalDisposition::Completed,
        content: "done".into(),
        content_sha256: "content-sha".into(),
        work_status: None,
        accepted_work_result: None,
        runtime_failure: None,
        execution_outcome: None,
        artifacts: vec![],
        changed_files: vec![],
        plan: Some(json!({"private":"retained"})),
        model_identity: None,
        extensions: serde_json::Map::from_iter([("futureField".into(), json!({"retained":true}))]),
    };
    let outbox = DeliveryOutbox {
        outbox_id: "outbox-1".into(),
        final_payload_ref: reference,
        expected_message_id: "assistant-1".into(),
        content: "done".into(),
        status: DeliveryStatus::Pending,
    };
    repositories
        .commit_transition(
            &turn,
            &claim,
            &TurnTransition::AcceptFinal {
                route: ExecutionRoute::Direct,
                payload: Box::new(payload),
                outbox: Box::new(outbox),
            },
        )
        .await
        .expect("commit final");
    let committed = repositories
        .activate_successor(&turn.turn_id)
        .await
        .expect("load committed");
    assert_eq!(
        committed.semantic_state,
        TurnSemanticState::DeliveryCommitted
    );
    assert_eq!(
        repositories
            .stop(&turn.turn_id)
            .await
            .expect("stop finalizing turn"),
        StopPersistenceOutcome::AlreadyFinalizing
    );
    assert_eq!(
        repositories
            .insert(&committed)
            .await
            .expect("insert canonical"),
        "assistant-1"
    );
    let delivery_claim = repositories
        .acquire_state_claim(
            &repositories
                .activate_successor(&turn.turn_id)
                .await
                .expect("reload inserted outbox"),
        )
        .await
        .expect("claim delivery");
    let inserted = repositories
        .activate_successor(&turn.turn_id)
        .await
        .expect("load inserted");
    repositories
        .commit_transition(
            &inserted,
            &delivery_claim,
            &TurnTransition::ObserveDelivery {
                assistant_message_id: "assistant-1".into(),
            },
        )
        .await
        .expect("observe delivery");
    let delivered = repositories
        .activate_successor(&turn.turn_id)
        .await
        .expect("load delivered");
    assert_eq!(delivered.semantic_state, TurnSemanticState::Delivered);
    assert_eq!(
        delivered.canonical_assistant_message_id.as_deref(),
        Some("assistant-1")
    );
    let delivered_payload = delivered.final_payload.expect("payload");
    assert_eq!(delivered_payload.plan, Some(json!({"private":"retained"})));
    assert_eq!(
        delivered_payload.extensions["futureField"],
        json!({"retained":true})
    );
    let stopped = repositories
        .stop(&turn.turn_id)
        .await
        .expect("stop delivered turn");
    let StopPersistenceOutcome::AlreadyDelivered(outcome) = stopped else {
        panic!("delivered Stop must replay the compatibility projection");
    };
    assert_eq!(outcome.message_id, "assistant-1");
    assert_eq!(outcome.content, "done");
    repositories.close().await.expect("close repository");
}

pub(super) fn prepared(turn_id: &str, trigger_key: &str, hash: &str) -> PreparedTurn {
    let request = TurnRequest {
        turn_id: turn_id.into(),
        recovery_attempt: None,
        session_id: "session-1".into(),
        event_id: trigger_key.into(),
        transport: "app".into(),
        account_id: "account-1".into(),
        peer: Peer {
            kind: PeerKind::Dm,
            id: "peer-1".into(),
            parent_id: None,
        },
        sender: Sender {
            id: "user-1".into(),
            display_name: None,
        },
        message: TurnMessage {
            id: format!("message-{turn_id}"),
            content: "hello".into(),
            timestamp: "2026-09-14T00:00:00.000Z".into(),
            attachments: vec![],
            image_admission: None,
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role: SessionRole::Butler,
            workspace_path: "/tmp".into(),
            project_id: None,
            reason: None,
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: None,
        app_turn_context: None,
        authority_request_ref: None,
        authority_client_message_id: None,
        app_queue_claim_id: None,
        preparation_cancellation: Default::default(),
    };
    let command = json!({"kind":"run","turnId":turn_id,"sessionId":"session-1","triggerKey":trigger_key,
        "message":{"messageId":format!("message-{turn_id}"),"content":"hello"},
        "modelSelection":{"provider":"openai","model":"gpt","reasoningEffort":"medium","contextWindowTokens":100},
        "context":{"messageContent":"hello"}});
    PreparedTurn {
        preparation_id: format!("preparation-{turn_id}"),
        request,
        command,
        admission_input_hash: hash.into(),
        is_fresh: true,
    }
}
