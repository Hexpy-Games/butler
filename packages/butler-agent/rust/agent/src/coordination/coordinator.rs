use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use super::error::{CoordinationError, CoordinationResult, sqlite_error, unavailable};
use super::fence::{
    bind_coordinator_fence, coordinator_path, initialize_coordinator, is_busy, open_readwrite,
    read_coordinator_meta, read_known_coordinator, write_owner,
};
use super::types::{
    CognitionCoordinationHost, CognitionWaitClass, CognitionWriteAcquire,
    ConsolidationLockInspection, LockInfo,
};

#[derive(Clone)]
pub(crate) struct CognitionWriteCoordinator {
    inner: Arc<CoordinatorInner>,
}

pub(super) struct CoordinatorInner {
    pub(super) host: Arc<dyn CognitionCoordinationHost>,
    pub(super) pid: u32,
    pub(super) hostname: String,
    pub(super) local: Mutex<HashMap<PathBuf, LocalRegistration>>,
}

#[derive(Clone)]
pub(super) struct LocalRegistration {
    pub(super) registration_id: String,
    pub(super) owner: LockInfo,
}

pub(crate) struct CognitionWriteLease {
    inner: Arc<CoordinatorInner>,
    lock_path: PathBuf,
    registration_id: String,
    owner: LockInfo,
    connection: Option<Connection>,
}

impl CognitionWriteCoordinator {
    pub(crate) fn new(host: Arc<dyn CognitionCoordinationHost>) -> CoordinationResult<Self> {
        let pid = host.process_id();
        let hostname = host.hostname()?;
        Ok(Self {
            inner: Arc::new(CoordinatorInner {
                host,
                pid,
                hostname,
                local: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub(crate) fn try_acquire(
        &self,
        request: CognitionWriteAcquire,
    ) -> CoordinationResult<Option<CognitionWriteLease>> {
        self.inner.try_acquire(&request)
    }

    pub(crate) async fn acquire(
        &self,
        mut request: CognitionWriteAcquire,
        wait_class: CognitionWaitClass,
    ) -> CoordinationResult<Option<CognitionWriteLease>> {
        let budget = match wait_class {
            CognitionWaitClass::Interactive => 5_000,
            CognitionWaitClass::Background => 30_000,
        };
        let bounded_deadline = self.inner.host.now_epoch_millis().saturating_add(budget) as f64;
        request.deadline_at_epoch_ms = Some(request.deadline_at_epoch_ms.map_or(
            bounded_deadline,
            |deadline| {
                if deadline.is_nan() {
                    f64::NAN
                } else {
                    deadline.min(bounded_deadline)
                }
            },
        ));
        loop {
            if cancelled(&request) {
                return Err(CoordinationError::new(
                    "memory_write_aborted",
                    "Memory writer acquisition was aborted",
                ));
            }
            if let Some(lease) = self.inner.try_acquire(&request)? {
                return Ok(Some(lease));
            }
            let remaining = request.deadline_at_epoch_ms.unwrap_or(f64::INFINITY)
                - self.inner.host.now_epoch_millis() as f64;
            if remaining <= 0.0 {
                return Ok(None);
            }
            let wait = if remaining.is_nan() {
                Duration::ZERO
            } else {
                Duration::from_millis(remaining.min(20.0) as u64)
            };
            if let Some(cancellation) = &request.cancellation {
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        return Err(CoordinationError::new(
                            "memory_write_aborted",
                            "Memory writer acquisition was aborted",
                        ));
                    }
                    _ = tokio::time::sleep(wait) => {}
                }
            } else if wait.is_zero() {
                tokio::task::yield_now().await;
            } else {
                tokio::time::sleep(wait).await;
            }
        }
    }

    pub(crate) fn inspect(
        &self,
        lock_path: &Path,
    ) -> CoordinationResult<ConsolidationLockInspection> {
        self.inner.inspect(lock_path)
    }

    #[cfg(test)]
    pub(super) fn replace_registration_for_test(
        &self,
        path: PathBuf,
        registration_id: String,
        owner: LockInfo,
    ) {
        self.inner.local.lock().unwrap().insert(
            path,
            LocalRegistration {
                registration_id,
                owner,
            },
        );
    }

    #[cfg(test)]
    pub(super) fn registration_for_test(&self, path: &Path) -> Option<String> {
        self.inner
            .local
            .lock()
            .unwrap()
            .get(path)
            .map(|value| value.registration_id.clone())
    }

    #[cfg(test)]
    pub(super) fn clear_registration_for_test(&self, path: &Path) {
        self.inner.local.lock().unwrap().remove(path);
    }
}

impl CoordinatorInner {
    fn try_acquire(
        self: &Arc<Self>,
        request: &CognitionWriteAcquire,
    ) -> CoordinationResult<Option<CognitionWriteLease>> {
        if cancelled(request) || expired(request, self.host.now_epoch_millis()) {
            return Ok(None);
        }
        match read_known_coordinator(&request.lock_path) {
            Ok(Some(_)) => {}
            Ok(None) => {
                initialize_coordinator(&request.lock_path, self.pid, &self.host)?;
            }
            Err(error) if error.code == "memory_write_busy" => return Ok(None),
            Err(error) => return Err(error),
        }
        let initialized = match read_known_coordinator(&request.lock_path) {
            Ok(Some(meta)) => meta,
            Ok(None) => return Err(unavailable("coordinator initialization unavailable")),
            Err(error) if error.code == "memory_write_busy" => return Ok(None),
            Err(error) => return Err(error),
        };
        if initialized.fence_sha256.is_none()
            && !bind_coordinator_fence(&request.lock_path, &self.hostname, &self.host)?
        {
            return Ok(None);
        }
        if cancelled(request) || expired(request, self.host.now_epoch_millis()) {
            return Ok(None);
        }
        let verified = match read_known_coordinator(&request.lock_path) {
            Ok(Some(meta)) => meta,
            Ok(None) => return Err(unavailable("coordinator verification unavailable")),
            Err(error) if error.code == "memory_write_busy" => return Ok(None),
            Err(error) => return Err(error),
        };
        if verified.fence_sha256.is_none() {
            return Err(unavailable("coordinator fence unbound"));
        }
        let connection = match open_readwrite(&coordinator_path(&request.lock_path)) {
            Ok(connection) => connection,
            Err(error) if error.code == "memory_write_busy" => return Ok(None),
            Err(error) => return Err(error),
        };
        if let Err(error) = connection.execute_batch("BEGIN EXCLUSIVE") {
            return if is_busy(&error) {
                Ok(None)
            } else {
                Err(unavailable(error))
            };
        }
        if cancelled(request) || expired(request, self.host.now_epoch_millis()) {
            let _ = connection.execute_batch("ROLLBACK");
            return Ok(None);
        }
        let acquired = (|| {
            let current = read_coordinator_meta(&connection)?
                .filter(|meta| meta.format_version == super::fence::COORDINATOR_VERSION)
                .ok_or_else(|| unavailable("coordinator metadata mismatch"))?;
            let known = read_known_coordinator_inside(&request.lock_path, current)?;
            if !known {
                return Err(unavailable("coordinator fence changed"));
            }
            let purpose = request
                .purpose
                .as_deref()
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
                .unwrap_or("projection")
                .to_owned();
            let registration_id = self.host.new_uuid();
            let owner = LockInfo {
                pid: u64::from(self.pid),
                started_at: self.host.now_iso(),
                host: self.hostname.clone(),
                owner_nonce: self.host.new_uuid(),
                purpose,
            };
            write_owner(&connection, &owner)?;
            Ok((registration_id, owner))
        })();
        let (registration_id, owner) = match acquired {
            Ok(value) => value,
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(error);
            }
        };
        self.local.lock().unwrap().insert(
            request.lock_path.clone(),
            LocalRegistration {
                registration_id: registration_id.clone(),
                owner: owner.clone(),
            },
        );
        Ok(Some(CognitionWriteLease {
            inner: self.clone(),
            lock_path: request.lock_path.clone(),
            registration_id,
            owner,
            connection: Some(connection),
        }))
    }

    fn remove_registration(&self, path: &Path, registration_id: &str) {
        let mut local = self.local.lock().unwrap();
        if local
            .get(path)
            .is_some_and(|current| current.registration_id == registration_id)
        {
            local.remove(path);
        }
    }
}

impl CognitionWriteLease {
    pub(crate) fn owner(&self) -> &LockInfo {
        &self.owner
    }

    pub(crate) fn assert_for_path(&self, path: &Path) -> CoordinationResult<()> {
        if self.lock_path != path || self.connection.is_none() {
            return Err(unavailable("consolidation lease does not own path"));
        }
        Ok(())
    }

    pub(crate) fn release(mut self, commit: bool) -> CoordinationResult<()> {
        self.finish(commit)
    }

    fn finish(&mut self, commit: bool) -> CoordinationResult<()> {
        let Some(connection) = self.connection.take() else {
            return Ok(());
        };
        let completion = connection.execute_batch(if commit { "COMMIT" } else { "ROLLBACK" });
        let completion_error = completion.err();
        if completion_error.is_some() && commit {
            let _ = connection.execute_batch("ROLLBACK");
        }
        let close_error = connection.close().err().map(|(_, error)| error);
        self.inner
            .remove_registration(&self.lock_path, &self.registration_id);
        if let Some(error) = completion_error {
            return Err(sqlite_error(error));
        }
        if let Some(error) = close_error {
            return Err(unavailable(error));
        }
        Ok(())
    }
}

impl Drop for CognitionWriteLease {
    fn drop(&mut self) {
        let _ = self.finish(false);
    }
}

fn read_known_coordinator_inside(
    lock_path: &Path,
    meta: super::fence::CoordinatorMeta,
) -> CoordinationResult<bool> {
    let Some(expected) = meta.fence_sha256 else {
        return Ok(false);
    };
    let bytes = std::fs::read(lock_path).map_err(unavailable)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(super::fence::digest(&text) == expected)
}

fn cancelled(request: &CognitionWriteAcquire) -> bool {
    request
        .cancellation
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
}

fn expired(request: &CognitionWriteAcquire, now: i64) -> bool {
    request
        .deadline_at_epoch_ms
        .is_some_and(|deadline| now as f64 >= deadline)
}
