//! Process-owned canonical stores, opened before Turn admission and closed last.

use std::path::Path;
use std::sync::Arc;

use crate::btcc::{
    BtccError, BtccStorage, BtccStorageConfig, ProcessLiveness, RuntimeOwnerIdentity,
    StorageActivation, StorageProfile,
};
use crate::conversation::{
    AgentConversationStore, ConversationStoreConfig, conversation_store_path,
};
use crate::coordination::{CognitionCoordinationHost, CognitionProcessStatus};
use crate::locale::LocaleCollation;
use crate::workspace::{
    SessionBindingStore, SessionBindingStoreConfig, WorkspaceStorageProfile, session_store_path,
};

use super::{SystemIdentity, prepare_btcc_storage};

pub(super) struct RuntimeStores {
    pub btcc: BtccStorage,
    pub bindings: SessionBindingStore,
    pub conversations: AgentConversationStore,
}

impl RuntimeStores {
    pub(super) async fn open(
        data_root: &Path,
        collation: Arc<LocaleCollation>,
    ) -> Result<Self, BtccError> {
        let root = data_root.to_owned();
        let bootstrap = tokio::task::spawn_blocking(move || {
            prepare_btcc_storage(&root, env!("CARGO_PKG_VERSION"))
        })
        .await
        .map_err(|e| error("storage_bootstrap_worker_failed", e))?
        .map_err(|e| error("storage_bootstrap_failed", e))?;
        let host_id = SystemIdentity
            .hostname()
            .map_err(|e| error("runtime_host_identity_failed", e))?;
        let btcc = BtccStorage::open(BtccStorageConfig {
            path: bootstrap.path,
            profile: StorageProfile::Durable,
            activation: StorageActivation {
                manifest_id: bootstrap.manifest_id,
            },
            runtime_owner: RuntimeOwnerIdentity {
                owner_id: uuid::Uuid::new_v4().to_string(),
                host_id: host_id.clone(),
                process_id: std::process::id(),
                process_started_at_ms: u64::try_from(SystemIdentity.now_epoch_millis().max(0))
                    .unwrap_or_default(),
            },
            process_liveness: Arc::new(NativeProcessLiveness { host_id }),
        })
        .await
        .map_err(|e| error(e.code, &e.message))?;
        let bindings = match SessionBindingStore::open(SessionBindingStoreConfig {
            path: session_store_path(data_root),
            storage_profile: WorkspaceStorageProfile::Durable,
            clock: Arc::new(SystemIdentity),
        })
        .await
        {
            Ok(store) => store,
            Err(e) => {
                let _ = btcc.close().await;
                return Err(error(e.code, &e.message));
            }
        };
        let conversations = match AgentConversationStore::open(ConversationStoreConfig {
            path: conversation_store_path(data_root),
            identity_clock: Arc::new(SystemIdentity),
            collation,
        })
        .await
        {
            Ok(store) => store,
            Err(e) => {
                let _ = bindings.close().await;
                let _ = btcc.close().await;
                return Err(error(e.code(), e.message()));
            }
        };
        Ok(Self {
            btcc,
            bindings,
            conversations,
        })
    }

    pub(super) async fn close(&self) -> Result<(), BtccError> {
        // Attempt every release even if an earlier store reports an error.
        let conversations = self
            .conversations
            .close()
            .await
            .map_err(|e| error(e.code(), e.message()));
        let bindings = self
            .bindings
            .close()
            .await
            .map_err(|e| error(e.code, e.message));
        let btcc = self
            .btcc
            .close()
            .await
            .map_err(|e| error(e.code, e.message));
        conversations.and(bindings).and(btcc)
    }
}

struct NativeProcessLiveness {
    host_id: String,
}

impl ProcessLiveness for NativeProcessLiveness {
    fn is_alive(&self, owner: &RuntimeOwnerIdentity) -> bool {
        // A remote or permission-denied process is not proven dead. Reclamation
        // is allowed only after an actual local ESRCH probe.
        owner.host_id != self.host_id
            || SystemIdentity.process_status(u64::from(owner.process_id))
                != CognitionProcessStatus::DefinitelyDead
    }
}

fn error(code: impl Into<String>, message: impl std::fmt::Display) -> BtccError {
    BtccError::new(code, message.to_string())
}
