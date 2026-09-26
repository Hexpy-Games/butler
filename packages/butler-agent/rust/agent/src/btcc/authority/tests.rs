use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, SessionWorkRepository, StorageError, ToolJournalRepository,
    ToolJournalStart,
};
use crate::btcc::work::{
    DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput, StartWorkInput, WorkTurnScope,
};
use crate::btcc::{SuspensionReason, TurnStore, TurnTransition};
use crate::locale::LocaleCollation;

mod bun_oracle;
mod policy_tests;

fn clock() -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(|| "2026-09-19T00:00:00.000Z".into())
}
fn principal(storage: BtccStorage) -> NativePrincipalAuthority {
    let sequence = Arc::new(std::sync::atomic::AtomicUsize::new(1));
    NativePrincipalAuthority::new(
        storage,
        Arc::new(LocaleCollation::new("en-US").unwrap()),
        clock(),
        Arc::new(move || {
            format!(
                "00000000-0000-4000-8000-{:012x}",
                sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            )
        }),
    )
}
fn scope() -> WorkTurnScope {
    WorkTurnScope {
        turn_id: "turn".into(),
        session_id: "session".into(),
        project_ref: None,
    }
}
fn input(work: &str, plan: &str) -> AuthorityAdmissionInput {
    AuthorityAdmissionInput {
        public_action_title: Some("Run checked command".into()),
        owner_session_id: "session".into(),
        source_session_id: "session".into(),
        source_turn_id: "turn".into(),
        operation_occurrence_id: Some("call-1".into()),
        source_work_id: work.into(),
        workspace_path: "/tmp".into(),
        plan_revision_id: plan.into(),
        action_key: "a".into(),
        authority_generation: 1,
        capability: "run_command".into(),
        target: "echo".into(),
        model_ref: "openai/gpt".into(),
        reasoning_effort: "medium".into(),
        category: None,
        normalized_input: json!({"command":"echo hi","cwd":"/tmp","state_effect":"mutation"}),
    }
}

#[tokio::test]
async fn real_turn_work_journal_authority_resume_outcome_and_reopen() {
    let fixture = crate::btcc::storage::tests::Fixture::activated();
    let storage = BtccStorage::open(fixture.config("authority-real"))
        .await
        .unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    let (turn, fresh) = turns
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
        .await
        .unwrap();
    assert!(fresh);
    let claim = turns.acquire_state_claim(&turn).await.unwrap();
    let work_service = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        storage.clone(),
        clock(),
    )));
    let work = work_service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start-authority-work".into(),
            objective: "review a command".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    let planned = work_service
        .replace_plan(ReplacePlanInput {
            scope: scope(),
            mutation_call_id: "plan-authority-work".into(),
            start_new: None,
            backfill_tool_call_ids: None,
            objective: "review a command".into(),
            governing_refs: None,
            execution_mode: Some(ExecutionMode::Direct),
            actions: vec![PlanAction {
                action_key: "a".into(),
                description: "review and run".into(),
                dependency_keys: vec![],
                effect: None,
            }],
            checks: vec!["approved".into()],
        })
        .await
        .unwrap();
    let plan = planned.current_plan.unwrap().plan_revision_id;
    let journal = ToolJournalRepository::new(storage.clone(), clock());
    journal
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
    let admitted = authority.admit(input(&work.work_id, &plan)).await.unwrap();
    let AuthorityAdmissionResult::Pending {
        request_ref,
        projection,
    } = admitted
    else {
        panic!("pending authority")
    };
    assert_eq!(projection["executable"], "echo");
    let call_status: String = storage
        .execute(|db| {
            db.query_row(
                "SELECT status FROM btcc_guided_tool_calls WHERE call_id='call-1'",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(call_status, "awaiting_authority");
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
    assert_eq!(authority.list("session".into()).await.unwrap().len(), 1);
    let decided = authority
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
    assert_eq!(decided.decision, "allowed");
    assert_eq!(
        authority
            .resume_source(request_ref.clone())
            .await
            .unwrap()
            .unwrap()
            .turn_id,
        "turn"
    );
    assert!(turns.resume_authority("turn").await.unwrap().is_some());
    let execution = authority
        .execution(AuthorityExecutionInput {
            owner_session_id: "session".into(),
            request_ref: request_ref.clone(),
            source_session_id: Some("session".into()),
            client_message_id: Some(decided.schedule_client_message_id),
            turn_id: "turn".into(),
        })
        .await
        .unwrap();
    assert_eq!(execution.normalized_input["command"], "echo hi");
    authority
        .record_outcome(AuthorityOutcomeInput {
            request_ref: request_ref.clone(),
            owner_session_id: "session".into(),
            source_work_id: work.work_id,
            status: "applied".into(),
            receipt: Some(
                json!({"schema":"butler.authority-outcome-receipt.v1","outcome":"applied",
            "evidenceRef":format!("authority-evidence-{}", "a".repeat(64)),
            "journalEffectId":format!("guided-effect-{}", "b".repeat(64)),"dispatchAttempt":1}),
            ),
        })
        .await
        .unwrap();
    storage.close().await.unwrap();
    let reopened = BtccStorage::open(fixture.config("authority-reopened"))
        .await
        .unwrap();
    let persisted = principal(reopened.clone())
        .execution(AuthorityExecutionInput {
            owner_session_id: "session".into(),
            request_ref,
            source_session_id: None,
            client_message_id: None,
            turn_id: "turn".into(),
        })
        .await
        .unwrap();
    assert_eq!(persisted.outcome, "applied");
    assert_eq!(persisted.outcome_receipt.unwrap()["dispatchAttempt"], 1);
    reopened.close().await.unwrap();
}
