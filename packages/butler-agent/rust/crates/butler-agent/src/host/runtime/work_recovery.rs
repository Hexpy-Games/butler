//! The process marker and attempt reconciliation run before managed admission.
use butler_turn::btcc::{BtccError, BtccStorage};
use butler_work::store;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) struct RecoveryOwner {
    storage: BtccStorage,
    boot_id: String,
    pub(super) interrupted: Arc<Vec<Value>>,
}
impl RecoveryOwner {
    pub(super) async fn start(storage: BtccStorage) -> Result<Self, BtccError> {
        let mut owner = Self {
            storage,
            interrupted: Arc::new(Vec::new()),
            boot_id: uuid::Uuid::new_v4().to_string(),
        };
        let boot = owner.boot_id.clone();
        // Marker and recovery commit together: a crash during recovery cannot
        // turn a previously clean checkpoint into a crash failure on restart.
        let interrupted = owner
            .storage
            .work_model_write(move |tx| {
                let ctx = context();
                let previous = store::begin_boot(tx, &ctx, &boot)?;
                let mut interrupted = Vec::new();
                let mut after = String::new();
                while let Some(session) = store::next_recovery_session(tx, &after)? {
                    interrupted.extend(store::recover_session(tx, &ctx, &session, previous)?);
                    after = session;
                }
                Ok(interrupted)
            })
            .await
            .map_err(BtccError::from)?;
        owner.interrupted = Arc::new(interrupted);
        Ok(owner)
    }

    pub(super) async fn close(&self) -> Result<(), BtccError> {
        let boot = self.boot_id.clone();
        self.storage
            .work_model_write(move |tx| {
                let ctx = context();
                let mut after = String::new();
                while let Some(session) = store::next_recovery_session(tx, &after)? {
                    store::checkpoint_session(tx, &ctx, &session)?;
                    after = session;
                }
                store::mark_clean_shutdown(tx, &ctx, &boot)
            })
            .await
            .map_err(BtccError::from)
    }
}
fn context() -> store::Context {
    store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: json!({"runtime":"recovery"}),
    }
}
