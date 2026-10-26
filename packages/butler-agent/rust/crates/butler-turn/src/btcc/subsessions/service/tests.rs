use std::sync::Arc;

use serde_json::json;

use super::{
    InterruptedSubsessionEvent, SubsessionChildQueue, SubsessionEnqueue, SubsessionService,
    WorkerProfile, WorkerProfileReader,
};
use crate::btcc::{
    BtccError, BtccRepositories, BtccStorage, CheckpointCommand, ClaimCloseoutCorrectionInput,
    ContinueWorkCommand, DispositionCommand, DurableWorkRepository, DurableWorkService,
    DurableWorkStatus, LegacyImport, PortFuture, ReplacePlanCommand, ReviewCommand,
    SessionWorkRepository, SqliteSubsessionRepository, StartWorkCommand, StartWorkInput,
    SubsessionCreate, TestStorageFixture, TurnStore, WorkContext, WorkScope, WorkTurnScope,
    WorkView,
};
use crate::workspace::{
    OwnOptional, SessionBindingStore, SessionBindingStoreConfig, SessionRole, UpsertSessionBinding,
    WorkspaceStorageProfile,
};

use std::sync::Mutex;

struct EmptyQueue;

impl SubsessionChildQueue for EmptyQueue {
    fn enqueue(&self, _input: SubsessionEnqueue) -> Result<(), BtccError> {
        Ok(())
    }

    fn interrupted_event(
        &self,
        _event_id: &str,
        _session_id: &str,
        _turn_id: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError> {
        Ok(None)
    }
}

struct EmptyProfiles;

impl WorkerProfileReader for EmptyProfiles {
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn read(&self, _profile_id: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async { Err(BtccError::relayed("worker_profile_missing", "missing")) })
    }
}

#[tokio::test]
async fn cancelled_child_abandons_bound_work_and_commits_cancelled_result() {
    let fixture = TestStorageFixture::activated();
    let storage_config = fixture.config("subsession-cancel");
    let test_root = storage_config.path.parent().unwrap().to_path_buf();
    let storage = BtccStorage::open(storage_config).await.unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    let (turn, fresh) = turns
        .load_or_admit(&crate::btcc::test_prepared_turn())
        .await
        .unwrap();
    assert!(fresh);
    let child_turn_id = turn.turn_id;
    let child_session_id = turn.session_id;
    let durable_work = Arc::new(DurableWorkService::new(Arc::new(
        SessionWorkRepository::new(storage.clone(), Arc::new(|| "now".into())),
    )));
    let repository = SqliteSubsessionRepository::new(storage.clone());
    let scope = WorkTurnScope {
        turn_id: child_turn_id.clone(),
        session_id: child_session_id.clone(),
        project_ref: None,
    };
    let root_work = durable_work
        .start_work(StartWorkInput {
            scope,
            mutation_call_id: format!("subsession-root-work:delegation:task:{child_session_id}"),
            objective: "Complete the delegated task.".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    assert!(
        repository
            .create(SubsessionCreate {
                relation_id: "relation-cancel".into(),
                delegation_id: "delegation".into(),
                task_id: "task".into(),
                parent_session_id: "parent-session".into(),
                parent_turn_id: "parent-turn".into(),
                child_session_id: child_session_id.clone(),
                child_turn_id: child_turn_id.clone(),
                anchor_message_id: "anchor".into(),
                safe_title: "Delegated task".into(),
                root_work_id: root_work.work_id,
                packet: crate::btcc::SubsessionPacket::fixture(
                    crate::btcc::ChildRole::Steward,
                    "Complete the delegated task.",
                ),
                dispatch_intent: crate::btcc::DispatchIntent::fixture(),
                created_at: "now".into(),
            })
            .await
            .unwrap()
    );
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path: test_root.join("sessions.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(crate::test_clock::SystemClock),
    })
    .await
    .unwrap();
    // Dispatch creates the child binding before the child can run; the
    // service validates the root Work scope against it on completion.
    bindings
        .upsert(UpsertSessionBinding {
            session_id: child_session_id.clone(),
            role: SessionRole::Steward,
            project_id: None,
            app_project_id: OwnOptional::Absent,
            ledger_project_id: OwnOptional::Absent,
            workspace_path: "/tmp/workspace".into(),
            runtime_adapter_id: "test-runtime".into(),
            model_provider_id: "provider".into(),
            model_ref: "provider/model".into(),
            runtime_session_ref: None,
            provider_thread_ref: None,
            transport_bindings: Vec::new(),
            lifecycle_state: None,
            created_at: None,
            updated_at: None,
            last_active_at: None,
            metadata: Some(
                json!({"runtimePolicy":{"trackingMode":"local"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        })
        .await
        .unwrap();
    let service = SubsessionService::new(
        repository.clone(),
        bindings.clone(),
        Arc::new(EmptyQueue),
        Arc::new(EmptyProfiles),
        durable_work.clone(),
        Arc::new(|| "now".into()),
    );

    service
        .complete_child(
            &child_session_id,
            &child_turn_id,
            "cancelled",
            "Delegated work was cancelled.".into(),
        )
        .await
        .unwrap();

    let work_view = durable_work
        .bound_work_for_turn(child_turn_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(work_view.status, DurableWorkStatus::Abandoned);
    let pending = repository.pending_parent_inputs().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].route, crate::btcc::ParentResultRoute::ButlerApp);
    let crate::btcc::ParentResultInput::ButlerApp(input) = &pending[0].input else {
        panic!("expected a butler App result");
    };
    assert!(input.text.contains("status: cancelled"));
    assert_eq!(input.safe_title, "Delegated task");

    drop(service);
    drop(repository);
    drop(durable_work);
    bindings.close().await.unwrap();
    storage.close().await.unwrap();
}

mod child_work;
mod worker_races;

/// KEEP: delegation ids are digests of these identity encodings.
pub(crate) fn delegation_identities_are_byte_stable() {
    let steward = super::helpers::StewardIdentity {
        parent_session_id: "ps",
        parent_turn_id: "pt",
        request: "req",
        work_id: "w",
        plan_revision_id: "p",
        review_revision_id: Some("r"),
        previous_relation_id: None,
    };
    assert_eq!(
        serde_json::to_string(&steward).unwrap(),
        r#"{"parent_session_id":"ps","parent_turn_id":"pt","request":"req","work_id":"w","plan_revision_id":"p","review_revision_id":"r"}"#
    );
    let one_call = super::helpers::StewardIdentity {
        review_revision_id: None,
        ..steward
    };
    assert_eq!(
        serde_json::to_string(&one_call).unwrap(),
        r#"{"parent_session_id":"ps","parent_turn_id":"pt","request":"req","work_id":"w","plan_revision_id":"p"}"#
    );
    let worker = super::helpers::WorkerIdentity {
        parent_session_id: "ps",
        parent_turn_id: "pt",
        action_key: "a",
        objective: "o",
        acceptance_criteria: &["c".to_owned()],
        implementation_brief: "b",
        profile_id: "id",
    };
    assert_eq!(
        serde_json::to_string(&worker).unwrap(),
        r#"{"parent_session_id":"ps","parent_turn_id":"pt","action_key":"a","objective":"o","acceptance_criteria":["c"],"implementation_brief":"b","profile_id":"id"}"#
    );
}
