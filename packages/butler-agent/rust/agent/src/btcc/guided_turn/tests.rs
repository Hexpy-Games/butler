use std::sync::Arc;

use serde_json::json;

use crate::btcc::authority::contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityDecisionInput,
    NativePrincipalAuthority,
};
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, SessionWorkRepository, ToolJournalRepository, ToolJournalStart,
};
use crate::btcc::work::{
    DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput, StartWorkInput, WorkTurnScope,
};
use crate::btcc::{SuspensionReason, TurnStore, TurnTransition};
use crate::locale::LocaleCollation;

use super::*;

fn clock() -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(|| "2026-09-19T00:00:00.000Z".into())
}
fn authority(storage: BtccStorage) -> NativePrincipalAuthority {
    NativePrincipalAuthority::new(
        storage,
        Arc::new(LocaleCollation::new("en-US").unwrap()),
        clock(),
        Arc::new(|| "00000000-0000-4000-8000-000000000001".into()),
    )
}
fn scope() -> WorkTurnScope {
    WorkTurnScope {
        turn_id: "turn".into(),
        session_id: "session".into(),
        project_ref: None,
    }
}

#[tokio::test]
async fn real_work_and_authority_resume_prepare_against_one_reopened_storage_owner() {
    let fixture = crate::btcc::storage::tests::Fixture::activated();
    let storage = BtccStorage::open(fixture.config("guided-prepare"))
        .await
        .unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    let (turn, fresh) = turns
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
        .await
        .unwrap();
    assert!(fresh);
    let service = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        storage.clone(),
        clock(),
    )));
    let empty = load_guided_turn_work(&service, None, &turn, "local", "/tmp", None)
        .await
        .unwrap();
    assert!(empty.context.is_none() && !empty.bound);
    let started = service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "guided-start".into(),
            objective: "review one command".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    let initial = load_guided_turn_work(&service, None, &turn, "local", "/tmp", None)
        .await
        .unwrap();
    assert!(initial.bound);
    assert_eq!(initial.context.unwrap().work.work_id, started.work_id);
    let planned = service
        .replace_plan(ReplacePlanInput {
            scope: scope(),
            mutation_call_id: "guided-plan".into(),
            start_new: None,
            backfill_tool_call_ids: None,
            objective: "review one command".into(),
            governing_refs: None,
            execution_mode: Some(ExecutionMode::Direct),
            actions: vec![PlanAction {
                action_key: "a".into(),
                description: "review command".into(),
                dependency_keys: vec![],
                effect: None,
            }],
            checks: vec!["approved".into()],
        })
        .await
        .unwrap();
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
    let principal = authority(storage.clone());
    let admitted = principal
        .admit(AuthorityAdmissionInput {
            public_action_title: Some("Run reviewed command".into()),
            owner_session_id: "session".into(),
            source_session_id: "session".into(),
            source_turn_id: "turn".into(),
            operation_occurrence_id: Some("call-1".into()),
            source_work_id: started.work_id.clone(),
            workspace_path: "/tmp".into(),
            plan_revision_id: planned.current_plan.unwrap().plan_revision_id,
            action_key: "a".into(),
            authority_generation: 1,
            capability: "run_command".into(),
            target: "echo".into(),
            model_ref: "openai/gpt".into(),
            reasoning_effort: "medium".into(),
            category: None,
            normalized_input: json!({"command":"echo hi","cwd":"/tmp","state_effect":"mutation"}),
        })
        .await
        .unwrap();
    let AuthorityAdmissionResult::Pending { request_ref, .. } = admitted else {
        panic!("pending")
    };
    let claim = turns.acquire_state_claim(&turn).await.unwrap();
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
    let decided = principal
        .decide(AuthorityDecisionInput {
            owner_session_id: "session".into(),
            request_ref: request_ref.clone(),
            source_session_id: Some("session".into()),
            action: "allow".into(),
            allow_scope: Some("once".into()),
            alternative_input: None,
        })
        .await
        .unwrap();
    assert!(turns.resume_authority("turn").await.unwrap().is_some());
    let mut resumed = turns.find_turn("turn").await.unwrap().unwrap();
    resumed.context["authorityRequestRef"] = json!(request_ref);
    resumed.context["authorityClientMessageId"] = json!(decided.schedule_client_message_id);
    let decision = guided_authority_loop_decision(Some(&principal), &resumed, "session")
        .await
        .unwrap();
    assert_eq!(decision, Some(GuidedAuthorityDecision::Allow));
    let mut wrong_call = resumed.clone();
    wrong_call.authority_continuation.as_mut().unwrap()["callId"] = json!("other-call");
    assert!(matches!(
        guided_authority_loop_decision(Some(&principal), &wrong_call, "session").await,
        Err(GuidedPreparationError::Contract(
            "authority_source_call_mismatch"
        ))
    ));
    assert!(
        load_guided_turn_work(&service, Some(&principal), &resumed, "local", "/tmp", None)
            .await
            .unwrap()
            .bound
    );
    let wrong_owner = guided_authority_loop_decision(Some(&principal), &resumed, "other").await;
    assert!(matches!(
        wrong_owner,
        Err(GuidedPreparationError::Authority(_))
    ));
    let wrong_path = load_guided_turn_work(
        &service,
        Some(&principal),
        &resumed,
        "local",
        "/elsewhere",
        None,
    )
    .await;
    assert!(matches!(
        wrong_path,
        Err(GuidedPreparationError::Contract(
            "authority_request_identity_mismatch"
        ))
    ));
    storage.close().await.unwrap();
    let reopened = BtccStorage::open(fixture.config("guided-reopened"))
        .await
        .unwrap();
    let reopened_service = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        reopened.clone(),
        clock(),
    )));
    assert!(
        load_guided_turn_work(
            &reopened_service,
            Some(&authority(reopened.clone())),
            &resumed,
            "local",
            "/tmp",
            None
        )
        .await
        .unwrap()
        .bound
    );
    reopened.close().await.unwrap();
}
