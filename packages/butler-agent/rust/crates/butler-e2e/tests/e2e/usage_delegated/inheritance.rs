//! Root inheritance through persisted subsession recovery, separate from policy tests.
use super::*;
use butler_turn::workspace::SessionRole;
use butler_turn::{btcc::*, workspace::*};
use serde_json::json;
use std::sync::Arc;

struct Clock;
impl WorkspaceClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        butler_core::js_date::parse_iso_millis(value)
    }
    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String> {
        Ok(butler_core::js_date::format_iso_millis(value).unwrap())
    }
}
struct Queue;
impl SubsessionChildQueue for Queue {
    fn enqueue(&self, _: SubsessionEnqueue) -> Result<(), BtccError> {
        Ok(())
    }
    fn interrupted_event(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError> {
        Ok(None)
    }
}
struct Profiles;
impl WorkerProfileReader for Profiles {
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn read(&self, _: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async { Err(BtccError::relayed("no_profile", "No profile")) })
    }
}

#[tokio::test]
async fn child_usage_roots_survive_recovery_and_grandchildren() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = TestStorageFixture::activated();
    let config = fixture.config("inheritance");
    let path = config.path.with_file_name("sessions.sqlite");
    let db_path = config.path.clone();
    let storage = BtccStorage::open(config).await.unwrap();
    let repository = SqliteSubsessionRepository::new(storage.clone());
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path,
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(Clock),
    })
    .await
    .unwrap();
    let work = Arc::new(DurableWorkService::new(Arc::new(
        SessionWorkRepository::new(storage.clone(), Arc::new(|| "now".into())),
    )));
    let service = SubsessionService::new(
        repository.clone(),
        bindings.clone(),
        Arc::new(Queue),
        Arc::new(Profiles),
        work,
        Arc::new(|| "now".into()),
    );
    for (index, (metadata, known_root)) in [
        (json!({}), Some("")),
        (
            json!({"subsession":{"root_session_id":"chat"}}),
            Some("chat"),
        ),
        (json!({"subsession":{"parent_session_id":"chat"}}), None),
    ]
    .into_iter()
    .enumerate()
    {
        let parent = format!("parent-{index}");
        bindings
            .upsert(UpsertSessionBinding {
                session_id: parent.clone(),
                role: SessionRole::Steward,
                project_id: None,
                app_project_id: OwnOptional::Null,
                ledger_project_id: OwnOptional::Null,
                workspace_path: "/tmp".into(),
                runtime_adapter_id: "runtime".into(),
                model_provider_id: "provider".into(),
                model_ref: "provider/model".into(),
                runtime_session_ref: None,
                provider_thread_ref: None,
                transport_bindings: vec![],
                lifecycle_state: None,
                created_at: None,
                updated_at: None,
                last_active_at: None,
                metadata: metadata.as_object().cloned(),
            })
            .await
            .unwrap();
        let expected = known_root.map(|root| {
            if root.is_empty() {
                parent.as_str()
            } else {
                root
            }
        });
        let mut source = parent.clone();
        for depth in 0..2 {
            let child = format!("child-{index}-{depth}");
            let mut packet = SubsessionPacket::fixture(ChildRole::Worker, "Task");
            packet.parent_session_id = source.clone();
            let db = rusqlite::Connection::open(&db_path)?;
            db.execute("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES (?1,?2,'turn',?1,'anchor',1,'Task','now')", rusqlite::params![child, source])?;
            db.execute("INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at) VALUES (?1,?1,?1,?2,?3,?4,?5,'pending','now')", rusqlite::params![child, format!("turn-{child}"), format!("work-{child}"), serde_json::to_string(&packet)?, serde_json::to_string(&DispatchIntent::fixture())?])?;
            drop(db);
            service.recover_assignments(Vec::new()).await.unwrap();
            let binding = bindings.get_by_session_id(&child).await.unwrap().unwrap();
            assert_eq!(
                binding.metadata.unwrap()["subsession"]["root_session_id"].as_str(),
                expected
            );
            source = child;
        }
    }
    bindings.close().await.unwrap();
    storage.close().await.unwrap();
    Ok(())
}

#[tokio::test]
async fn usage_policy_roots_are_independent_of_runtime_policy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("usage-policy"))
        .await
        .unwrap();
    let repositories = BtccRepositories::new(storage.clone(), None);
    let (mut turn, _) = repositories
        .load_or_admit(&test_prepared_turn())
        .await
        .unwrap();
    let catalog = GuidedCatalogSnapshot::parse(r#"{"tools":[],"profiles":{},"workerDefault":[],"workerForbidden":[],"projectMutations":[],"projectInspection":[],"workTracking":[],"managedLedgerEffects":[],"allLedgerEffects":[]}"#).unwrap();
    let own_id = turn.session_id.clone();
    for (role, subsession, expected_root, expected_role) in [
        ("butler", json!(null), Some(own_id.as_str()), "main"),
        (
            "steward",
            json!({"rootSessionId":"chat","executionMode":"read_only"}),
            Some("chat"),
            "steward",
        ),
        (
            "steward",
            json!({"executionMode":"read_only"}),
            None,
            "steward",
        ),
        ("worker", json!({}), None, "worker"),
    ] {
        turn.context = json!({"executionPolicy":{"role":role,"trackingMode":"local","workspacePath":"/tmp","subsession":subsession}});
        let phase = select_phase(GuidedPhaseInput {
            turn: &turn,
            catalog: &catalog,
            phase_surface_flag: "0",
            operation_replay_flag: "0",
            default_workspace: "/tmp",
        })
        .unwrap();
        assert_eq!(
            phase.execution_policy.usage_root(&turn.session_id),
            expected_root
        );
        assert_eq!(phase.execution_policy.usage_role(), expected_role);
    }
    storage.close().await.unwrap();
    Ok(())
}
