use super::stops::response;
use super::*;
use butler_turn::btcc::storage::{
    BtccRepositories, BtccStorage, BtccStorageConfig, ProcessLiveness, RuntimeOwnerIdentity,
    StorageActivation, StorageProfile, read_activated_storage_manifest,
};
use butler_turn::btcc::{PreparedTurn, TurnCommand, TurnStore};

struct Offline;
impl ProcessLiveness for Offline {
    fn is_alive(&self, _: &RuntimeOwnerIdentity) -> bool {
        false
    }
}

#[tokio::test]
async fn stale_control_attempt_keeps_delivered_failure_and_outbox() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, stub, server) = setup(false).await.unwrap();
    *stub.responses.lock().unwrap() = vec![response(PARTIAL, "future_reason")];
    let (id, turn) = s.turn("general", "Explain the design.").await.unwrap();
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    s.agent.terminate().await.unwrap();
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let (command, canonical): (Value, String) = {
        let db = butler_platform::sqlite::open(&path)?;
        let raw: String = db.query_row(
            "SELECT command_json FROM btcc_inbound_inbox WHERE turn_id=?1",
            [&id],
            |r| r.get(0),
        )?;
        (serde_json::from_str(&raw)?, canonical_delivery(&db, &id)?)
    };
    let storage = BtccStorage::open(BtccStorageConfig {
        activation: StorageActivation {
            manifest_id: read_activated_storage_manifest(&path).unwrap(),
        },
        path: path.clone(),
        profile: StorageProfile::Durable,
        runtime_owner: RuntimeOwnerIdentity {
            owner_id: "replay-check".into(),
            host_id: "stub-host".into(),
            process_id: std::process::id(),
            process_started_at_ms: 1,
        },
        process_liveness: Arc::new(Offline),
    })
    .await
    .unwrap();
    let repos = BtccRepositories::new(storage, None);
    let before = repos.find_turn(&id).await.unwrap().unwrap();
    let request: butler_turn::btcc::TurnRequest = serde_json::from_value(json!({
        "turnId":id,"sessionId":before.session_id,"eventId":"stale","transport":"app","accountId":"local",
        "peer":{"kind":"dm","id":"general"},"sender":{"id":"local"},
        "message":{"id":"stale","content":"","timestamp":"2026-10-27T00:00:00Z"},
        "trigger":{"kind":"user_message"},"route":{"role":"butler","workspacePath":s.sandbox.workspace}
    }))?;
    for mut command in [command, json!({"kind":"resume","turnId":id})] {
        command["recoveryAttempt"] = json!(2);
        let prepared = PreparedTurn {
            preparation_id: "stale".into(),
            request: request.clone(),
            command: serde_json::from_value::<TurnCommand>(command)?,
            admission_input_hash: "unused-existing".into(),
            is_fresh: false,
        };
        let (after, fresh) = repos.load_or_admit(&prepared).await.unwrap();
        assert!(!fresh);
        assert_eq!(after, before, "stale control reopened delivered failure");
        assert!(after.delivery_outbox.is_some());
        assert!(after.canonical_assistant_message_id.is_some());
    }
    repos.close().await.unwrap();
    let db = butler_platform::sqlite::open(&path)?;
    assert_eq!(canonical_delivery(&db, &id)?, canonical);
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

fn canonical_delivery(db: &rusqlite::Connection, turn: &str) -> Result<String, HarnessError> {
    Ok(db.query_row(
        "SELECT json_object('outbox',outbox_id,'message',assistant_message_id,'inserted',inserted_at) FROM btcc_canonical_deliveries WHERE turn_id=?1",
        [turn], |row| row.get(0),
    )?)
}
