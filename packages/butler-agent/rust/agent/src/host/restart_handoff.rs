//! One-shot post-delivery service restart handoff over the existing effect journal.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use crate::{
    ResolvedInstallation,
    btcc::{
        BtccStorage, BtccStorageConfig, ProcessLiveness, RuntimeOwnerIdentity, StorageActivation,
        StorageEffectJournal, StorageProfile, ToolJournalRepository,
        read_activated_storage_manifest,
    },
    coordination::CognitionCoordinationHost,
};

use super::service_instance::RestartIdentity;
use super::{SystemIdentity, iso_timestamp};

pub(crate) struct NativeRestartHandoff {
    tools: Arc<ToolJournalRepository>,
    effects: Arc<StorageEffectJournal>,
    installation: ResolvedInstallation,
    data_root: PathBuf,
    identity: RestartIdentity,
}

/// Helper result enters the same durable journal owner. An online service owns
/// its BTCC lane; only a fully unlocked DATA may be opened by the helper.
pub(crate) async fn record_helper_terminal(
    data_root: &Path,
    installation: &ResolvedInstallation,
    intent_id: &str,
    state: &'static str,
) -> Result<(), String> {
    super::service_instance::validate_write_destinations(data_root, installation)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    let _admission = loop {
        match super::service_instance::AdmissionLock::acquire(data_root, installation) {
            Ok(lock) => break lock,
            Err(error)
                if error == "service_start_admission_busy"
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            Err(error) => return Err(error),
        }
    };
    if super::service_instance::instance_is_locked(data_root)? {
        let record = super::service_instance::read_record(data_root)?
            .ok_or("restart_handoff_owner_ambiguous")?;
        if !super::service_instance::process_matches(&record)? {
            return Err("restart_handoff_owner_ambiguous".into());
        }
        let online =
            super::gateway_lifecycle::report_restart_handoff(&record, intent_id, state).await;
        if online.is_ok() {
            return online;
        }
        // Shutdown may close control just before releasing the instance lock.
        // Admission remains held, so no new service can take DATA while this
        // helper waits briefly for the old BTCC owner to release it.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while super::service_instance::instance_is_locked(data_root)?
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        if super::service_instance::instance_is_locked(data_root)? {
            return online;
        }
    }
    if super::service_instance::read_record(data_root)?
        .is_some_and(|record| super::service_instance::process_matches(&record).unwrap_or(true))
    {
        return Err("restart_handoff_owner_ambiguous".into());
    }
    let path = data_root.join("agent-runtime/btcc.sqlite");
    for destination in [data_root.join("agent-runtime"), path.clone()] {
        if std::fs::symlink_metadata(&destination)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("restart_handoff_journal_path_ambiguous".into());
        }
        if !installation
            .validate_data_root(&destination)?
            .starts_with(data_root)
        {
            return Err("restart_handoff_journal_outside_data".into());
        }
    }
    if !path.is_file() {
        return Err("restart_handoff_journal_unavailable".into());
    }
    let manifest_id = read_activated_storage_manifest(&path)
        .map_err(|_| "restart_handoff_journal_unavailable".to_owned())?;
    let host_id = SystemIdentity
        .hostname()
        .map_err(|_| "restart_handoff_host_identity_unavailable".to_owned())?;
    let storage = BtccStorage::open(BtccStorageConfig {
        path,
        profile: StorageProfile::Durable,
        activation: StorageActivation { manifest_id },
        runtime_owner: RuntimeOwnerIdentity {
            owner_id: uuid::Uuid::new_v4().to_string(),
            host_id: host_id.clone(),
            process_id: std::process::id(),
            process_started_at_ms: u64::try_from(SystemIdentity.now_epoch_millis().max(0))
                .unwrap_or_default(),
        },
        process_liveness: Arc::new(HandoffProcessLiveness { host_id }),
    })
    .await
    .map_err(|_| "restart_handoff_journal_unavailable".to_owned())?;
    let journal = StorageEffectJournal::new(
        storage.clone(),
        Arc::new(|| iso_timestamp(SystemTime::now())),
    );
    let result = journal
        .finish_restart_handoff(intent_id.to_owned(), state)
        .await
        .map_err(|error| error.code.clone());
    let closed = storage
        .close()
        .await
        .map_err(|_| "restart_handoff_journal_close_failed".to_owned());
    result.and(closed)
}

struct HandoffProcessLiveness {
    host_id: String,
}
impl ProcessLiveness for HandoffProcessLiveness {
    fn is_alive(&self, owner: &RuntimeOwnerIdentity) -> bool {
        owner.host_id != self.host_id
            || SystemIdentity.process_status(u64::from(owner.process_id))
                != crate::coordination::CognitionProcessStatus::DefinitelyDead
    }
}

impl NativeRestartHandoff {
    pub(crate) fn new(
        tools: Arc<ToolJournalRepository>,
        effects: Arc<StorageEffectJournal>,
        installation: ResolvedInstallation,
        data_root: PathBuf,
        identity: RestartIdentity,
    ) -> Self {
        Self {
            tools,
            effects,
            installation,
            data_root,
            identity,
        }
    }

    /// Called only after the canonical final App action and inbound queue.complete.
    /// The claim precedes spawn: a crash at this boundary leaves an explicit
    /// uncertain attempt and cannot cause an automatic second restart.
    pub(crate) async fn after_final(&self, turn_id: &str) -> Result<(), String> {
        let calls = self
            .tools
            .restart_requests(turn_id.to_owned())
            .await
            .map_err(|error| error.code)?;
        for call in calls {
            if call.tool_name != "request_service_restart" || call.status != "completed" {
                continue;
            }
            let Some(result) = call.result else { continue };
            let parsed: serde_json::Value = serde_json::from_str(result.as_str())
                .map_err(|_| "restart_handoff_result_invalid".to_owned())?;
            let value = parsed
                .get("output")
                .filter(|_| parsed["ok"] == true)
                .unwrap_or(&parsed);
            if value.get("requested") != Some(&serde_json::Value::Bool(true))
                || value.get("status").and_then(serde_json::Value::as_str) != Some("pending")
                || value
                    .pointer("/effect_receipt/capability")
                    .and_then(serde_json::Value::as_str)
                    != Some("request_service_restart")
            {
                continue;
            }
            let Some(key) = value
                .get("handoff_request_id")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let Some(receipt_id) = value
                .pointer("/effect_receipt/receipt_id")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            if !self
                .effects
                .claim_restart_handoff(key.to_owned(), receipt_id.to_owned())
                .await
                .map_err(|error| error.code)?
            {
                continue;
            }
            let state = if super::service_cli::spawn_restart_handoff(
                &self.installation,
                &self.data_root,
                &self.identity,
                key,
            )
            .is_ok()
            {
                "spawned"
            } else {
                "spawn_failed"
            };
            self.effects
                .record_restart_handoff(key.to_owned(), state)
                .await
                .map_err(|error| error.code)?;
            if state == "spawn_failed" {
                return Err("restart_handoff_spawn_failed".into());
            }
            // One completed Turn can hand off at most one process restart.
            return Ok(());
        }
        Ok(())
    }
}
