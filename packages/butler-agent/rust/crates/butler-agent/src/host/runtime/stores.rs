//! Process-owned canonical stores, opened before Turn admission and closed last.

use std::path::Path;
use std::sync::Arc;

use butler_core::locale::LocaleCollation;
use butler_memory::coordination::{CognitionCoordinationHost, CognitionProcessStatus};
use butler_turn::btcc::{
    BtccError, BtccStorage, BtccStorageConfig, ProcessLiveness, RuntimeOwnerIdentity,
    StorageActivation, StorageProfile,
};
use butler_turn::conversation::{
    AgentConversationStore, ConversationStoreConfig, conversation_store_path,
};
use butler_turn::workspace::{
    SessionBindingStore, SessionBindingStoreConfig, WorkspaceStorageProfile, session_store_path,
};

use crate::host::{SystemIdentity, prepare_btcc_storage};

pub(in crate::host) struct RuntimeStores {
    pub btcc: BtccStorage,
    pub bindings: SessionBindingStore,
    pub conversations: AgentConversationStore,
}

impl RuntimeStores {
    pub(in crate::host) async fn open(
        data_root: &Path,
        collation: Arc<LocaleCollation>,
        stop: &tokio_util::sync::CancellationToken,
    ) -> Result<Self, BtccError> {
        let btcc = open_btcc(data_root, stop).await?;
        if let Err(error) = check_startup(stop) {
            let _ = btcc.close().await;
            return Err(error);
        }
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
                return Err(error(e.code(), e.message()));
            }
        };
        if let Err(error) = check_startup(stop) {
            let _ = bindings.close().await;
            let _ = btcc.close().await;
            return Err(error);
        }
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
        let stores = Self {
            btcc,
            bindings,
            conversations,
        };
        if let Err(error) = check_startup(stop) {
            let _ = stores.close().await;
            return Err(error);
        }
        Ok(stores)
    }

    pub(in crate::host) async fn close(&self) -> Result<(), BtccError> {
        // Attempt every release even if an earlier store reports an error.
        // Producers have joined. These separate SQLite owners can close together.
        use crate::host::service::shutdown_trace::measure;
        let (conversations, bindings, btcc) = tokio::join!(
            measure("conversations_store", self.conversations.close()),
            measure("bindings_store", self.bindings.close()),
            measure("btcc_store", self.btcc.close()),
        );
        let conversations = conversations.map_err(|e| error(e.code(), e.message()));
        let bindings = bindings.map_err(|e| error(e.code(), e.message()));
        let btcc = btcc.map_err(|e| error(e.code(), e.message()));
        conversations.and(bindings).and(btcc)
    }
}

struct ProcessLivenessProbe {
    host_id: String,
}

impl ProcessLiveness for ProcessLivenessProbe {
    fn is_alive(&self, owner: &RuntimeOwnerIdentity) -> bool {
        // A remote or permission-denied process is not proven dead. Reclamation
        // is allowed only after an actual local ESRCH probe.
        owner.host_id != self.host_id
            || SystemIdentity.process_status(u64::from(owner.process_id))
                != CognitionProcessStatus::DefinitelyDead
    }
}

fn error(code: impl Into<String>, message: impl std::fmt::Display) -> BtccError {
    BtccError::relayed(code.into(), message.to_string())
}

pub(super) fn check_startup(stop: &tokio_util::sync::CancellationToken) -> Result<(), BtccError> {
    if stop.is_cancelled() {
        Err(BtccError::relayed(
            "native_service_start_cancelled",
            "Service is stopping",
        ))
    } else {
        Ok(())
    }
}

async fn open_btcc(
    data_root: &Path,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<BtccStorage, BtccError> {
    let root = data_root.to_owned();
    let bootstrap = tokio::task::spawn_blocking(move || {
        prepare_btcc_storage(&root, env!("BUTLER_RELEASE_VERSION"))
    })
    .await
    .map_err(|e| error("storage_bootstrap_worker_failed", e))?
    .map_err(|e| error("storage_bootstrap_failed", e))?;
    check_startup(stop)?;
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
        process_liveness: Arc::new(ProcessLivenessProbe { host_id }),
    })
    .await
    .map_err(|e| error(e.code(), e.message()))?;
    Ok(btcc)
}
