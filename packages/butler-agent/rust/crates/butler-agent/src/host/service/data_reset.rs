//! Reset ownership survives a disconnected requester and fences native admission.
mod apply;
mod cleanup;
mod inventory;
pub(crate) mod journal;
mod logs;
mod moves;
pub(super) mod plan;
mod recovery;
mod secrets;
use crate::host::ResolvedInstallation;
use butler_gateway::gateway::{
    ApplicationFuture, FullResetRequest, GatewayApplicationError, ResetNonce,
};
use journal::{Journal, Phase};
pub(crate) use recovery::{finish, initialize_owned, protected_roots, recover};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(crate) struct Control {
    root: PathBuf,
    requested: PathBuf,
    db: PathBuf,
    installation: ResolvedInstallation,
    generation: String,
    nonces: Mutex<VecDeque<(String, Instant)>>,
    changes: tokio::sync::Mutex<()>,
    resetting: AtomicBool,
    callbacks: OnceLock<(
        tokio_util::sync::CancellationToken,
        Arc<dyn Fn() + Send + Sync>,
    )>,
}
impl Control {
    pub(crate) async fn open(
        root: PathBuf,
        requested: PathBuf,
        db: PathBuf,
        installation: ResolvedInstallation,
    ) -> Result<Arc<Self>, butler_turn::btcc::BtccError> {
        let data = root.clone();
        let generation = tokio::task::spawn_blocking(move || journal::generation(&data))
            .await
            .map_err(|e| {
                butler_turn::btcc::BtccError::relayed("data_generation_unavailable", e.to_string())
            })?
            .map_err(|e| {
                butler_turn::btcc::BtccError::relayed("data_generation_unavailable", e.to_string())
            })?;
        Ok(Arc::new(Self {
            root,
            requested,
            db,
            installation,
            generation,
            nonces: Mutex::new(VecDeque::new()),
            changes: tokio::sync::Mutex::new(()),
            resetting: AtomicBool::new(false),
            callbacks: OnceLock::new(),
        }))
    }
    pub(crate) fn attach(
        &self,
        dispatch: tokio_util::sync::CancellationToken,
        stop: Arc<dyn Fn() + Send + Sync>,
    ) {
        let _ = self.callbacks.set((dispatch, stop));
    }
    pub(crate) fn resetting(&self) -> bool {
        self.resetting.load(Ordering::Acquire)
    }
    pub(crate) fn generation(&self) -> &str {
        &self.generation
    }
    pub(crate) fn nonce(&self) -> Result<ResetNonce, GatewayApplicationError> {
        let mut nonces = self
            .nonces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        nonces.retain(|(_, expiration)| *expiration > now);
        if nonces.len() >= 64 {
            nonces.pop_front();
        }
        let nonce = uuid::Uuid::new_v4().to_string();
        nonces.push_back((nonce.clone(), now + Duration::from_secs(120)));
        let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(120)).to_rfc3339();
        Ok(ResetNonce { nonce, expires_at })
    }
    fn consume(&self, input: &Value) -> Result<FullResetRequest, GatewayApplicationError> {
        let nonce = input
            .get("nonce")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let mut nonces = self
            .nonces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let index = nonces
            .iter()
            .position(|(n, _)| n == nonce)
            .ok_or_else(invalid)?;
        let (_, expires) = nonces.remove(index).ok_or_else(invalid)?;
        if expires <= Instant::now() {
            return Err(invalid());
        }
        let request: FullResetRequest =
            serde_json::from_value(input.clone()).map_err(|_| invalid())?;
        if !valid_id(&request.operation_id) || request.confirmation != "reset-all-data" {
            return Err(invalid());
        }
        Ok(request)
    }
    pub(crate) fn request(self: &Arc<Self>, input: &Value) -> ApplicationFuture<Value> {
        let request = self.consume(input);
        let this = self.clone();
        Box::pin(async move {
            let request = request?;
            let _change = this.changes.lock().await;
            if this.resetting() {
                return Err(public(409, "full_reset_in_progress"));
            }
            let owner = this.clone();
            let operation_id = request.operation_id;
            let id = operation_id.clone();
            tokio::task::spawn_blocking(move || owner.prepare(id))
                .await
                .map_err(GatewayApplicationError::internal_from)??;
            Ok(json!({"operation_id":operation_id,"restart":"app"}))
        })
    }
    fn prepare(&self, id: String) -> Result<(), GatewayApplicationError> {
        let _journal_change = journal::CHANGES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let pending = journal::load(&self.root).map_err(GatewayApplicationError::internal_from)?;
        if pending
            .as_ref()
            .is_some_and(|j| matches!(j.phase, Phase::Requested | Phase::RollingBack))
        {
            return Err(public(409, "full_reset_in_progress"));
        }
        let mut kept_logs = logs::paths();
        if let Some(pending) = &pending {
            merge(&mut kept_logs, pending.kept_logs.clone());
        }
        let moves = plan::preflight(
            &self.root,
            &self.requested,
            &self.db,
            &self.installation,
            &kept_logs,
        )
        .map_err(|code| public(409, code))?;
        let (mut secret_keys, mut project_hot_caches) = secrets::snapshot(&self.root, &self.db)
            .map_err(GatewayApplicationError::internal_from)?;
        let mut pending_trash = vec![PathBuf::from(format!("{}{id}", journal::TRASH_PREFIX))];
        if let Some(pending) = pending {
            merge(&mut pending_trash, pending.pending_trash);
            merge(&mut secret_keys, pending.secret_keys);
            merge(&mut project_hot_caches, pending.project_hot_caches);
        }
        let journal = Journal {
            schema: 1,
            id,
            phase: Phase::Requested,
            created_at: chrono::Utc::now().to_rfc3339(),
            secret_keys,
            project_hot_caches,
            moves,
            old_generation: self.generation.clone(),
            new_generation: uuid::Uuid::new_v4().to_string(),
            retried: false,
            relocations: Vec::new(),
            pending_trash,
            kept_logs,
        };
        butler_platform::secure_fs::abort_point("data_reset.before_journal");
        // A publication failure can occur after rename (directory fsync).
        // Fence even that indeterminate outcome until startup recovery settles it.
        let saved = journal.save(&self.root);
        self.resetting.store(true, Ordering::Release);
        if let Some((dispatch, stop)) = self.callbacks.get() {
            dispatch.cancel();
            let stop = stop.clone();
            tokio::spawn(async move {
                tokio::time::sleep(stop_delay()).await;
                stop();
            });
        }
        saved.map_err(GatewayApplicationError::internal_from)
    }
}
/// Runs `work` unless a reset has started. `prepare` lists secret keys and
/// publishes its journal under the same lock, so a key recorded by `work` is
/// either in that list or never written.
pub(crate) fn unless_resetting<T>(
    root: &std::path::Path,
    work: impl FnOnce() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let _journal_change = journal::CHANGES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let pending = journal::load(root)?;
    if pending.is_some_and(|j| matches!(j.phase, Phase::Requested | Phase::RollingBack)) {
        return Err(std::io::Error::other("full reset in progress"));
    }
    work()
}
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn stop_delay() -> Duration {
    #[cfg(feature = "e2e-fixtures")]
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && let Ok(value) = std::env::var("BUTLER_E2E_RESET_STOP_DELAY_MS")
        && let Ok(ms) = value.parse::<u64>()
    {
        return Duration::from_millis(ms.min(30_000));
    }
    Duration::from_secs(30)
}
fn invalid() -> GatewayApplicationError {
    public(400, "full_reset_confirmation_invalid")
}
fn public(status: u16, code: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: "Full reset is unavailable.".into(),
        source: None,
    }
}

fn merge<T: PartialEq>(into: &mut Vec<T>, pending: Vec<T>) {
    for value in pending {
        if !into.contains(&value) {
            into.push(value);
        }
    }
}
