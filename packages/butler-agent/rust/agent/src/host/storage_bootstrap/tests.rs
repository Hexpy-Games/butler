use std::sync::Arc;

use rusqlite::Connection;

use super::*;
use crate::btcc::{
    BtccStorage, BtccStorageConfig, ProcessLiveness, RuntimeOwnerIdentity, StorageActivation,
    StorageProfile,
};

struct LocalLiveness;

impl ProcessLiveness for LocalLiveness {
    fn is_alive(&self, _identity: &RuntimeOwnerIdentity) -> bool {
        true
    }
}

#[tokio::test]
async fn fresh_root_bootstraps_real_receipt_activation_and_storage_owner() {
    let root = std::env::temp_dir().join(format!("butler-btcc-fresh-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("butler.config.json"), "{\"models\":{}}\n").unwrap();
    let prepared = prepare_fresh_btcc_storage(&root, "native-test").expect("fresh bootstrap");
    assert_eq!(prepared.path, root.join("agent-runtime/btcc.sqlite"));
    assert_eq!(
        prepared.manifest_id,
        "ddf9f981df779464dbb2e74e888ee1fc66312337ba8f2a63f191dc02a1f5890f"
    );
    let db = Connection::open(&prepared.path).expect("published database");
    let receipt: String = db
        .query_row(
            "SELECT receipt_json FROM agent_storage_migration_receipt WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .expect("source receipt");
    let receipt: serde_json::Value = serde_json::from_str(&receipt).expect("receipt JSON");
    assert_eq!(receipt["sourceKind"], "fresh_install");
    assert_eq!(receipt["tables"].as_array().unwrap().len(), 47);
    let marker: String = db
        .query_row(
            "SELECT marker_json FROM agent_storage_activation_marker WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .expect("source activation marker");
    let marker: serde_json::Value = serde_json::from_str(&marker).expect("marker JSON");
    assert_eq!(marker["manifestId"], prepared.manifest_id);
    drop(db);

    let storage = BtccStorage::open(BtccStorageConfig {
        path: prepared.path.clone(),
        profile: StorageProfile::Durable,
        activation: StorageActivation {
            manifest_id: prepared.manifest_id.clone(),
        },
        runtime_owner: RuntimeOwnerIdentity {
            owner_id: "fresh-native-owner".to_owned(),
            host_id: "local-test-host".to_owned(),
            process_id: std::process::id(),
            process_started_at_ms: 1,
        },
        process_liveness: Arc::new(LocalLiveness),
    })
    .await
    .expect("actual BTCC owner open");
    storage.close().await.expect("actual BTCC owner close");
    let restarted = prepare_btcc_storage(&root, "native-test-restart").expect("validated reopen");
    assert_eq!(restarted.path, prepared.path);
    assert_eq!(restarted.manifest_id, prepared.manifest_id);
    let db = Connection::open(&prepared.path).expect("read activation after validation");
    let marker: String = db
        .query_row(
            "SELECT marker_json FROM agent_storage_activation_marker WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let marker: serde_json::Value = serde_json::from_str(&marker).unwrap();
    assert_eq!(marker["runtimeVersion"], "native-test");
    drop(db);
    let storage = BtccStorage::open(BtccStorageConfig {
        path: restarted.path,
        profile: StorageProfile::Durable,
        activation: StorageActivation {
            manifest_id: restarted.manifest_id,
        },
        runtime_owner: RuntimeOwnerIdentity {
            owner_id: "fresh-native-owner-restart".to_owned(),
            host_id: "local-test-host".to_owned(),
            process_id: std::process::id(),
            process_started_at_ms: 2,
        },
        process_liveness: Arc::new(LocalLiveness),
    })
    .await
    .expect("actual reopened BTCC owner");
    storage.close().await.expect("reopened BTCC owner close");
    std::fs::remove_dir_all(root).expect("remove isolated test root");
}
