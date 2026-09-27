//! Storage fixtures shared by BTCC tests and, through the `test-support`
//! feature, by scenario tests in dependent crates.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde_json::json;

use super::*;
use crate::btcc::{
    Peer, PeerKind, PreparedTurn, Sender, SessionRole, TurnMessage, TurnRequest, TurnRoute,
    TurnTrigger,
};

pub(crate) const MANIFEST: &str = "test-btcc-manifest";
static FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

/// A turn prepared for admission, with fixed identifiers.
pub fn prepared() -> PreparedTurn {
    let request = TurnRequest {
        turn_id: "turn".into(),
        recovery_attempt: None,
        session_id: "session".into(),
        event_id: "event".into(),
        transport: "app".into(),
        account_id: "account".into(),
        peer: Peer {
            kind: PeerKind::Dm,
            id: "peer".into(),
            parent_id: None,
        },
        sender: Sender {
            id: "user".into(),
            display_name: None,
        },
        message: TurnMessage {
            id: "message".into(),
            content: "hello".into(),
            timestamp: "now".into(),
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
    PreparedTurn {
        preparation_id: "preparation".into(),
        request,
        command: crate::btcc::TurnCommand::fixture_run(
            "turn",
            "session",
            "event",
            crate::btcc::CommandMessage {
                message_id: "message".into(),
                content: "hello".into(),
            },
            json!({"messageContent":"hello"}),
        ),
        admission_input_hash: "hash".into(),
        is_fresh: true,
    }
}

/// A temporary BTCC database; the directory is removed on drop.
pub struct Fixture {
    pub(crate) path: PathBuf,
}

impl Fixture {
    pub(crate) fn empty() -> Self {
        let sequence = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let local_sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "butler-btcc-storage-{}-{sequence}-{local_sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).expect("fixture directory");
        Self {
            path: directory.join("agent-btcc.sqlite"),
        }
    }

    pub fn activated() -> Self {
        let fixture = Self::empty();
        let connection = Connection::open(&fixture.path).expect("fixture connection");
        connection
            .execute_batch(
                "CREATE TABLE agent_storage_migration_receipt (singleton INTEGER PRIMARY KEY, \
                 manifest_id TEXT NOT NULL, receipt_json TEXT NOT NULL); \
                 CREATE TABLE agent_storage_activation_marker (singleton INTEGER PRIMARY KEY, \
                 manifest_id TEXT NOT NULL, marker_json TEXT NOT NULL);",
            )
            .expect("activation schema");
        connection
            .execute(
                "INSERT INTO agent_storage_migration_receipt VALUES (1, ?1, ?2)",
                params![MANIFEST, format!(
                    "{{\"schema\":\"butler.agent-btcc-storage-migration.v1\",\"manifestId\":\"{MANIFEST}\"}}"
                )],
            )
            .expect("receipt");
        connection
            .execute(
                "INSERT INTO agent_storage_activation_marker VALUES (1, ?1, ?2)",
                params![MANIFEST, format!(
                    "{{\"schema\":\"butler.agent-btcc-storage-activation.v1\",\"manifestId\":\"{MANIFEST}\",\"storageContract\":\"split-v1\",\"firstActivatedAt\":\"now\",\"activatedAt\":\"now\"}}"
                )],
            )
            .expect("activation");
        fixture
    }

    pub fn config(&self, owner_id: &str) -> BtccStorageConfig {
        BtccStorageConfig {
            path: self.path.clone(),
            profile: StorageProfile::Durable,
            activation: StorageActivation {
                manifest_id: MANIFEST.to_owned(),
            },
            runtime_owner: RuntimeOwnerIdentity {
                owner_id: owner_id.to_owned(),
                host_id: "test-host".to_owned(),
                process_id: std::process::id(),
                process_started_at_ms: 1,
            },
            process_liveness: Arc::new(ConservativeProcessLiveness),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(directory) = self.path.parent() {
            let _ignored_cleanup = std::fs::remove_dir_all(directory);
        }
    }
}
