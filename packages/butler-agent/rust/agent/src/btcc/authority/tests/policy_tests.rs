use std::sync::Arc;

use serde_json::json;

use super::{clock, input, principal, scope};
use crate::btcc::authority::{
    AuthorityAdmissionResult, AuthorityDecisionInput, AuthorityExecutionInput,
    AuthorityOutcomeInput, NativePrincipalAuthority,
};
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, SessionWorkRepository, StorageError, ToolJournalRepository,
    ToolJournalStart,
};
use crate::btcc::work::{
    DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput, StartWorkInput,
};
use crate::btcc::{SuspensionReason, TurnStore, TurnTransition};

struct Ready {
    _fixture: crate::btcc::storage::tests::Fixture,
    storage: BtccStorage,
    authority: NativePrincipalAuthority,
    request_ref: String,
    work_id: String,
    plan_id: String,
}
async fn ready(name: &str) -> Ready {
    let fixture = crate::btcc::storage::tests::Fixture::activated();
    let storage = BtccStorage::open(fixture.config(name)).await.unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    let (turn, _) = turns
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
        .await
        .unwrap();
    let claim = turns.acquire_state_claim(&turn).await.unwrap();
    let work_service = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        storage.clone(),
        clock(),
    )));
    let work = work_service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start-authority".into(),
            objective: "review command".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    let plan = work_service
        .replace_plan(ReplacePlanInput {
            scope: scope(),
            mutation_call_id: "plan-authority".into(),
            start_new: None,
            backfill_tool_call_ids: None,
            objective: "review command".into(),
            governing_refs: None,
            execution_mode: Some(ExecutionMode::Direct),
            actions: vec![PlanAction {
                action_key: "a".into(),
                description: "run after review".into(),
                dependency_keys: vec![],
                effect: None,
            }],
            checks: vec!["approved".into()],
        })
        .await
        .unwrap()
        .current_plan
        .unwrap()
        .plan_revision_id;
    ToolJournalRepository::new(storage.clone(), clock())
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "call-1".into(),
            tool_name: "run_command".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    let authority = principal(storage.clone());
    let AuthorityAdmissionResult::Pending { request_ref, .. } =
        authority.admit(input(&work.work_id, &plan)).await.unwrap()
    else {
        panic!("pending")
    };
    turns
        .commit_transition(
            &turn,
            &claim,
            &TurnTransition::Suspend {
                reason: SuspensionReason::AuthorityPending,
                authority_continuation: Some(json!({"requestRef":request_ref,"callId":"call-1"})),
            },
        )
        .await
        .unwrap();
    Ready {
        _fixture: fixture,
        storage,
        authority,
        request_ref,
        work_id: work.work_id,
        plan_id: plan,
    }
}
fn decision(request_ref: &str, action: &str) -> AuthorityDecisionInput {
    AuthorityDecisionInput {
        owner_session_id: "session".into(),
        request_ref: request_ref.into(),
        source_session_id: Some("session".into()),
        action: action.into(),
        allow_scope: Some("once".into()),
        alternative_input: None,
    }
}

#[tokio::test]
async fn modify_precedence_same_decision_replay_and_optional_execution_identity() {
    let ready = ready("authority-decision-policy").await;
    let mut invalid = decision("missing", "modify");
    invalid.alternative_input = Some(" \t".into());
    assert_eq!(
        ready.authority.decide(invalid).await.unwrap_err().code(),
        "authority_modify_input_missing"
    );
    let allowed = ready
        .authority
        .decide(decision(&ready.request_ref, "allow"))
        .await
        .unwrap();
    assert_eq!(
        ready
            .authority
            .decide(decision(&ready.request_ref, "allow"))
            .await
            .unwrap(),
        allowed
    );
    assert_eq!(
        ready
            .authority
            .decide(decision(&ready.request_ref, "deny"))
            .await
            .unwrap_err()
            .code(),
        "authority_decision_conflict"
    );
    let base = AuthorityExecutionInput {
        owner_session_id: "session".into(),
        request_ref: ready.request_ref.clone(),
        source_session_id: None,
        client_message_id: None,
        turn_id: "turn".into(),
    };
    assert_eq!(
        ready
            .authority
            .execution(base.clone())
            .await
            .unwrap()
            .decision,
        "allowed"
    );
    assert_eq!(
        ready
            .authority
            .execution(AuthorityExecutionInput {
                source_session_id: Some(String::new()),
                ..base.clone()
            })
            .await
            .unwrap_err()
            .code(),
        "authority_request_not_found"
    );
    assert_eq!(
        ready
            .authority
            .execution(AuthorityExecutionInput {
                client_message_id: Some(String::new()),
                ..base
            })
            .await
            .unwrap_err()
            .code(),
        "authority_request_not_found"
    );
    ready.storage.close().await.unwrap();
}

#[tokio::test]
async fn grant_precedence_revocation_and_operational_close_cas() {
    let ready = ready("authority-permission-policy").await;
    let mut allow = decision(&ready.request_ref, "allow");
    allow.allow_scope = Some("conversation".into());
    ready.authority.decide(allow).await.unwrap();
    let grants = ready
        .authority
        .list_permissions("session".into())
        .await
        .unwrap();
    assert_eq!(grants.len(), 1);
    let mut new_request = input(&ready.work_id, &ready.plan_id);
    new_request.action_key = "different-action".into();
    new_request.operation_occurrence_id = None;
    new_request.target = "different-target".into();
    assert_eq!(
        ready.authority.admit(new_request.clone()).await.unwrap(),
        AuthorityAdmissionResult::Granted
    );
    // Exact identity precedes the permission lookup even after grant revocation.
    assert!(matches!(
        ready
            .authority
            .admit(input(&ready.work_id, &ready.plan_id))
            .await
            .unwrap(),
        AuthorityAdmissionResult::Allowed { .. }
    ));
    ready
        .authority
        .revoke_permission("session".into(), grants[0].grant_ref.clone())
        .await
        .unwrap();
    assert!(
        ready
            .authority
            .list_permissions("session".into())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        ready.authority.admit(new_request).await.unwrap(),
        AuthorityAdmissionResult::Pending { .. }
    ));
    let close = ready
        .authority
        .close_self_session("session".into(), "session_cancelled".into())
        .await
        .unwrap();
    assert_eq!(close.closed_count, 1);
    let mut replay = decision(&ready.request_ref, "allow");
    replay.allow_scope = Some("conversation".into());
    assert_eq!(
        ready.authority.decide(replay).await.unwrap().decision,
        "allowed"
    );
    ready.storage.close().await.unwrap();
}

#[tokio::test]
async fn missing_started_call_rolls_back_pending_authority_insert() {
    let ready = ready("authority-rollback").await;
    let mut unmatched = input(&ready.work_id, &ready.plan_id);
    unmatched.action_key = "another".into();
    unmatched.operation_occurrence_id = Some("missing-call".into());
    let error = ready.authority.admit(unmatched).await.unwrap_err();
    assert_eq!(error.code(), "authority_source_call_not_pending");
    let rows: i64 = ready
        .storage
        .execute(|db| {
            db.query_row("SELECT COUNT(*) FROM btcc_authority_requests", [], |row| {
                row.get(0)
            })
            .map_err(StorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(rows, 1);
    ready.storage.close().await.unwrap();
}

#[tokio::test]
async fn terminal_slot_generation_and_close_decision_cas_preserve_source_order() {
    let ready = ready("authority-slot-generation").await;
    let mut different = input(&ready.work_id, &ready.plan_id);
    different.target = "different-target".into();
    different.operation_occurrence_id = None;
    assert_eq!(
        ready
            .authority
            .admit(different.clone())
            .await
            .unwrap_err()
            .code(),
        "authority_slot_identity_mismatch"
    );
    ready
        .authority
        .decide(decision(&ready.request_ref, "allow"))
        .await
        .unwrap();
    // A failed allowed outcome is terminal for slot reuse but remains retryable
    // for recordOutcome itself under the source update predicate.
    ready
        .authority
        .record_outcome(AuthorityOutcomeInput {
            request_ref: ready.request_ref.clone(),
            owner_session_id: "session".into(),
            source_work_id: ready.work_id.clone(),
            status: "failed".into(),
            receipt: None,
        })
        .await
        .unwrap();
    let AuthorityAdmissionResult::Pending {
        request_ref: generated,
        ..
    } = ready.authority.admit(different).await.unwrap()
    else {
        panic!("new generation")
    };
    let generation: i64 = ready
        .storage
        .execute(move |db| {
            db.query_row(
                "SELECT authority_generation FROM btcc_authority_requests WHERE request_ref=?1",
                [generated],
                |row| row.get(0),
            )
            .map_err(StorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(generation, 2);
    let close = ready
        .authority
        .close_self_session("session".into(), "session_cancelled".into())
        .await
        .unwrap();
    assert_eq!(close.closed_count, 1);
    // The original allowed row is not changed by the operational close.
    assert_eq!(
        ready
            .authority
            .execution(AuthorityExecutionInput {
                owner_session_id: "session".into(),
                request_ref: ready.request_ref,
                source_session_id: None,
                client_message_id: None,
                turn_id: "turn".into(),
            })
            .await
            .unwrap()
            .outcome,
        "failed"
    );
    ready.storage.close().await.unwrap();
}

#[tokio::test]
async fn corrupt_receipt_projection_fails_closed() {
    let second = ready("authority-corrupt-receipt").await;
    second
        .authority
        .decide(decision(&second.request_ref, "allow"))
        .await
        .unwrap();
    second.storage.execute({ let request = second.request_ref.clone(); move |db| {
        db.execute("UPDATE btcc_authority_requests SET outcome_receipt_json='{}' WHERE request_ref=?1",
            [request]).map_err(StorageError::sqlite)?;
        Ok(())
    }}).await.unwrap();
    assert_eq!(
        second
            .authority
            .execution(AuthorityExecutionInput {
                owner_session_id: "session".into(),
                request_ref: second.request_ref,
                source_session_id: None,
                client_message_id: None,
                turn_id: "turn".into(),
            })
            .await
            .unwrap_err()
            .code(),
        "authority_request_corrupt"
    );
    second.storage.close().await.unwrap();
}
