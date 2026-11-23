mod apply;
mod cloud;
mod key_store;
mod restore;
mod run;
mod schedule;
mod status;

pub(crate) use apply::apply_staged;

use std::{
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
};

use butler_backup::backup::{BackupError, BackupKey, LocalState};
use butler_gateway::gateway::{ButlerBackupRequest, GatewayApplicationError as Error};
use butler_turn::btcc::BtccError;
use serde_json::{Value, json};
use tokio::{sync::Notify, task::JoinHandle};

use super::{ResolvedInstallation, app::runtime_ports::ButlerAccount as Account};

type Result<T> = std::result::Result<T, Error>;

pub(crate) struct BackupService {
    inner: Arc<Inner>,
    schedule: Mutex<Option<JoinHandle<()>>>,
}

struct Inner {
    data_root: PathBuf,
    installation: ResolvedInstallation,
    cloud: cloud::Cloud,
    phase: Arc<Mutex<Phase>>,
    operations: tokio::sync::Mutex<()>,
    pending_key: Mutex<Option<BackupKey>>,
    now: Notify,
    local: Mutex<status::LocalView>,
    cloud_view: Mutex<Option<status::CloudView>>,
}

#[derive(Clone)]
enum Phase {
    Idle,
    Running { done: u64, total: u64 },
    Restoring { done: u64, total: u64 },
    RestoreReady,
    Failed(String),
}

impl BackupService {
    pub(crate) async fn start(
        data_root: &Path,
        installation: &ResolvedInstallation,
        account: Arc<Account>,
    ) -> std::result::Result<Self, BtccError> {
        let convert = |error: Error| BtccError::relayed("backup_unavailable", error.to_string());
        let root = data_root.to_path_buf();
        let state = tokio::task::spawn_blocking(move || LocalState::load(&root))
            .await
            .map_err(Error::internal_from)
            .map_err(convert)?
            .map_err(Error::internal_from)
            .map_err(convert)?;
        let service = Self {
            inner: Arc::new(Inner {
                data_root: data_root.to_path_buf(),
                installation: installation.clone(),
                cloud: cloud::Cloud::new(account).map_err(convert)?,
                phase: Arc::new(Mutex::new(Phase::Idle)),
                operations: tokio::sync::Mutex::new(()),
                pending_key: Mutex::new(None),
                now: Notify::new(),
                local: Mutex::new(status::LocalView::from(&state)),
                cloud_view: Mutex::new(None),
            }),
            schedule: Mutex::new(None),
        };
        if state.enabled {
            service.start_schedule();
        }
        Ok(service)
    }

    fn start_schedule(&self) {
        let mut task = self.schedule.lock().unwrap_or_else(PoisonError::into_inner);
        if task.as_ref().is_none_or(JoinHandle::is_finished) {
            *task = Some(tokio::spawn(schedule::run(self.inner.clone())));
        }
    }

    fn stop_schedule(&self) {
        if let Some(task) = self
            .schedule
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }

    pub(crate) async fn handle(&self, request: ButlerBackupRequest) -> Result<Value> {
        let session = self.inner.cloud.session().await?;
        match request {
            ButlerBackupRequest::Status => return self.inner.status(&session, false).await,
            ButlerBackupRequest::Refresh => return self.inner.status(&session, true).await,
            _ => (),
        }
        let _operation = self.inner.operations.lock().await;
        let phase = self.inner.phase();
        if matches!(phase, Phase::Running { .. } | Phase::Restoring { .. }) {
            return Err(error(
                409,
                "backup_busy",
                "A backup or restore is in progress.",
            ));
        }
        if matches!(request, ButlerBackupRequest::Restart) {
            if !matches!(phase, Phase::RestoreReady) {
                return Err(error(409, "restore_not_ready", "The restore is not ready."));
            }
            super::mcp::restart::restart_service(
                &self.inner.installation,
                &self.inner.data_root,
                "app",
            )
            .await
            .map_err(|_| error(500, "restart_failed", "Butler could not restart."))?;
            return Ok(json!({}));
        }
        if matches!(phase, Phase::RestoreReady) {
            return Err(error(
                409,
                "restore_ready",
                "Restart Butler to finish restoring.",
            ));
        }
        let enabled = self.inner.local_view().enabled;
        match request {
            ButlerBackupRequest::CreateKey | ButlerBackupRequest::NewKey => {
                self.create_key(&session, enabled).await
            }
            ButlerBackupRequest::Start => {
                self.enable(&session, self.inner.local_state().await?)
                    .await?;
                Ok(json!({}))
            }
            ButlerBackupRequest::Cancel => {
                self.inner
                    .pending_key
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                if !enabled {
                    self.inner.blocking(|root| key_store::delete(&root)).await?;
                }
                Ok(json!({}))
            }
            ButlerBackupRequest::BackUpNow if enabled => {
                self.inner.now.notify_one();
                Ok(json!({}))
            }
            ButlerBackupRequest::TurnOff => {
                self.turn_off(&session).await?;
                Ok(json!({}))
            }
            ButlerBackupRequest::Restore { recovery_key } => {
                self.inner.restore(&session, &recovery_key).await?;
                Ok(json!({}))
            }
            _ => Err(error(409, "backup_off", "Backup is off.")),
        }
    }

    async fn create_key(&self, session: &cloud::Session, enabled: bool) -> Result<Value> {
        require_plan(&session.inventory().await?)?;
        let key = BackupKey::generate();
        let text = json!({"recovery_key": key.recovery_text().as_str()});
        if enabled {
            self.inner
                .pending_key
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .replace(key);
        } else {
            self.inner
                .blocking(move |root| key_store::store(&root, &key))
                .await?;
        }
        Ok(text)
    }

    async fn enable(&self, session: &cloud::Session, mut state: LocalState) -> Result<()> {
        let inventory = session.inventory().await?;
        require_plan(&inventory)?;
        let pending = self
            .inner
            .pending_key
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(BackupKey::recovery_text);
        if state.enabled && pending.is_none() {
            return Ok(());
        }
        self.inner
            .blocking(|root| {
                if root
                    .join("auth/vault.age")
                    .try_exists()
                    .map_err(Error::internal_from)?
                {
                    check_vault(&root)?;
                }
                if key_store::load(&root)?.is_none() {
                    return Err(error(
                        409,
                        "backup_key_required",
                        "Create a recovery key first.",
                    ));
                }
                Ok(())
            })
            .await?;
        if pending.is_some() {
            session.delete_all().await?;
            state = LocalState::default();
        }
        let state = self
            .inner
            .blocking(move |root| {
                let old = key_store::load(&root)?.ok_or_else(Error::internal)?;
                let new = pending
                    .as_ref()
                    .map(|text| butler_backup::backup::parse_recovery(text))
                    .transpose()
                    .map_err(backup_error)?;
                update_vault(
                    &root,
                    new.as_ref().map(|_| &old),
                    Some(new.as_ref().unwrap_or(&old)),
                )?;
                if let Some(new) = new {
                    key_store::store(&root, &new)?;
                }
                state.enabled = true;
                state.last_error = None;
                state.usage.quota_bytes = inventory.quota_bytes;
                Ok(state)
            })
            .await?;
        self.inner.save_state(state).await?;
        self.inner
            .pending_key
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.inner.set_phase(Phase::Idle);
        self.start_schedule();
        self.inner.now.notify_one();
        Ok(())
    }

    async fn turn_off(&self, session: &cloud::Session) -> Result<()> {
        self.inner
            .blocking(|root| {
                let key = key_store::load(&root)?;
                update_vault(&root, key.as_ref(), None)
            })
            .await?;
        session.delete_all().await?;
        self.inner
            .cloud_view
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.inner.save_state(LocalState::default()).await?;
        self.stop_schedule();
        self.inner.blocking(|root| key_store::delete(&root)).await?;
        self.inner
            .pending_key
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.inner.set_phase(Phase::Idle);
        Ok(())
    }
}

impl Drop for BackupService {
    fn drop(&mut self) {
        self.stop_schedule();
    }
}

impl Inner {
    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(PathBuf) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let root = self.data_root.clone();
        tokio::task::spawn_blocking(move || f(root))
            .await
            .map_err(Error::internal_from)?
    }

    async fn local_state(&self) -> Result<LocalState> {
        self.blocking(|root| LocalState::load(&root).map_err(Error::internal_from))
            .await
    }

    async fn save_state(&self, state: LocalState) -> Result<()> {
        let view = status::LocalView::from(&state);
        self.blocking(move |root| state.save(&root).map_err(Error::internal_from))
            .await?;
        *self.local.lock().unwrap_or_else(PoisonError::into_inner) = view;
        Ok(())
    }

    fn local_view(&self) -> status::LocalView {
        self.local
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn phase(&self) -> Phase {
        self.phase
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set_phase(&self, phase: Phase) {
        *self.phase.lock().unwrap_or_else(PoisonError::into_inner) = phase;
    }
}

fn check_vault(root: &Path) -> Result<()> {
    if !matches!(butler_vault::vault::shared(root).active(), Ok(true)) {
        return Err(error(409, "vault_locked", "Unlock the Butler vault first."));
    }
    Ok(())
}

fn update_vault(root: &Path, old: Option<&BackupKey>, new: Option<&BackupKey>) -> Result<()> {
    if !root
        .join("auth/vault.age")
        .try_exists()
        .map_err(Error::internal_from)?
    {
        return Ok(());
    }
    check_vault(root)?;
    let recipient =
        |key: &BackupKey| butler_vault::vault::recovery_recipient(&key.subkeys().vault_secret);
    let old = old.map(recipient);
    let new = new.map(recipient);
    butler_vault::vault::shared(root)
        .set_recovery_recipient(old.as_deref(), new.as_deref())
        .map_err(Error::internal_from)
}

fn require_plan(inventory: &cloud::Inventory) -> Result<()> {
    if inventory.quota_bytes == 0 {
        return Err(error(
            403,
            "backup_not_in_plan",
            "Backup is unavailable on this plan.",
        ));
    }
    Ok(())
}

fn backup_error(failure: BackupError) -> Error {
    let status = if matches!(failure, BackupError::Io(_)) {
        500
    } else {
        400
    };
    Error::Public {
        status,
        code: failure.to_string(),
        message: "The backup could not be processed.".into(),
        source: Some(Arc::new(failure)),
    }
}

fn error(status: u16, code: &str, message: &str) -> Error {
    Error::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}

fn error_code(failure: &Error) -> String {
    match failure {
        Error::Public { code, .. } => code.clone(),
        Error::Internal { .. } => "io".into(),
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn graph_path(root: &Path) -> io::Result<Option<PathBuf>> {
    let Some(id) = butler_backup::backup::active_generation(root)? else {
        return Ok(None);
    };
    Ok(Some(
        root.join("cognition/memory/generations")
            .join(id)
            .join("graph.sqlite"),
    ))
}
