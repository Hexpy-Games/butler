//! The memory writer coordinator and its leases.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::Notify;

use super::error::{CoordinationError, CoordinationResult, invalid, sqlite_error};
use super::fence::{
    bind_coordinator_fence, coordinator_path, initialize_coordinator, is_busy, open_readwrite,
    read_coordinator_meta, read_known_coordinator_for_acquire, write_owner,
};
use super::types::{
    CognitionCoordinationHost, CognitionWaitClass, CognitionWriteAcquire,
    ConsolidationLockInspection, LockInfo,
};

/// Serializes memory writers across processes through a SQLite gate beside each lock file.
#[derive(Clone)]
pub struct CognitionWriteCoordinator {
    pub(super) inner: Arc<CoordinatorInner>,
}

pub(super) struct CoordinatorInner {
    pub(super) host: Arc<dyn CognitionCoordinationHost>,
    pub(super) pid: u32,
    pub(super) hostname: String,
    pub(super) local: Mutex<HashMap<PathBuf, LocalRegistration>>,
    /// Signalled whenever a lease of this process ends, so an in-process
    /// waiter retries at once instead of on a timer.
    pub(super) released: Notify,
    inventory_revision: AtomicU64,
}

#[derive(Clone)]
pub(super) struct LocalRegistration {
    pub(super) registration_id: String,
    pub(super) owner: LockInfo,
}

/// A held memory writer lock; released explicitly or when dropped.
pub struct CognitionWriteLease {
    inner: Arc<CoordinatorInner>,
    lock_path: PathBuf,
    registration_id: String,
    owner: LockInfo,
    connection: Option<Connection>,
}

impl CognitionWriteCoordinator {
    /// A coordinator for this process.
    pub fn new(host: Arc<dyn CognitionCoordinationHost>) -> CoordinationResult<Self> {
        let pid = host.process_id();
        let hostname = host.hostname()?;
        Ok(Self {
            inner: Arc::new(CoordinatorInner {
                host,
                pid,
                hostname,
                local: Mutex::new(HashMap::new()),
                released: Notify::new(),
                inventory_revision: AtomicU64::new(0),
            }),
        })
    }

    /// In-memory inventory invalidation epoch; reading it performs no I/O.
    pub fn inventory_revision(&self) -> u64 {
        self.inner
            .inventory_revision
            .load(Ordering::Acquire)
            .saturating_add(super::inventory::published_revision())
    }

    /// Invalidates management measurements after a mutation outside a lease.
    pub fn invalidate_inventory(&self) {
        self.inner.inventory_revision.fetch_add(1, Ordering::AcqRel);
    }

    pub(crate) fn try_acquire(
        &self,
        request: &CognitionWriteAcquire,
    ) -> CoordinationResult<Option<CognitionWriteLease>> {
        self.inner.try_acquire(request)
    }

    /// Waits for the writer lock; `None` when the request gives up.
    pub async fn acquire(
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
        let mut retry = MIN_RETRY;
        loop {
            if cancelled(&request) {
                return Err(CoordinationError::Aborted);
            }
            // Interest is registered before the attempt, so a lease released
            // between the attempt and the wait still wakes this waiter.
            let released = self.inner.released.notified();
            tokio::pin!(released);
            released.as_mut().enable();
            if !self.inner.held_locally(&request.lock_path)
                && let Some(lease) = self.inner.try_acquire(&request)?
            {
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
                #[expect(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "clamped to (0, MAX_RETRY] milliseconds above"
                )]
                let millis = remaining.min(retry.as_millis() as f64) as u64;
                Duration::from_millis(millis)
            };
            // Another process cannot signal this one, so the wait is bounded;
            // the bound grows while the lock stays busy.
            retry = (retry * 2).min(MAX_RETRY);
            if let Some(cancellation) = &request.cancellation {
                tokio::select! {
                    () = cancellation.cancelled() => {
                        return Err(CoordinationError::Aborted);
                    }
                    () = &mut released => {}
                    () = tokio::time::sleep(wait) => {}
                }
            } else if wait.is_zero() {
                tokio::task::yield_now().await;
            } else {
                tokio::select! {
                    () = &mut released => {}
                    () = tokio::time::sleep(wait) => {}
                }
            }
        }
    }

    pub(crate) fn inspect(
        &self,
        lock_path: &Path,
    ) -> CoordinationResult<ConsolidationLockInspection> {
        self.inner.inspect(lock_path)
    }
}

/// The first wait after a busy attempt, doubling up to [`MAX_RETRY`] while a
/// lock held by another process stays busy.
const MIN_RETRY: Duration = Duration::from_millis(20);
const MAX_RETRY: Duration = Duration::from_millis(250);

impl CoordinatorInner {
    /// Whether a lease of this process holds `lock_path` right now.
    fn held_locally(&self, lock_path: &Path) -> bool {
        self.local.lock().contains_key(lock_path)
    }

    /// Takes the writer lock when it is free right now; `None` when it is
    /// busy, the request was cancelled or its deadline passed.
    fn try_acquire(
        self: &Arc<Self>,
        request: &CognitionWriteAcquire,
    ) -> CoordinationResult<Option<CognitionWriteLease>> {
        if self.abandoned(request) || !self.ensure_bound(request)? {
            return Ok(None);
        }
        let Some(connection) = self.begin(request)? else {
            return Ok(None);
        };
        let (registration_id, owner) = match self.register_owner(&connection, request) {
            Ok(value) => value,
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(error);
            }
        };
        self.local.lock().insert(
            request.lock_path.clone(),
            LocalRegistration {
                registration_id: registration_id.clone(),
                owner: owner.clone(),
            },
        );
        self.inventory_revision.fetch_add(1, Ordering::AcqRel);
        Ok(Some(CognitionWriteLease {
            inner: self.clone(),
            lock_path: request.lock_path.clone(),
            registration_id,
            owner,
            connection: Some(connection),
        }))
    }

    fn abandoned(&self, request: &CognitionWriteAcquire) -> bool {
        cancelled(request) || expired(request, self.host.now_epoch_millis())
    }

    /// Initializes the coordinator database and binds it to the fence when
    /// needed; `false` when that is not possible right now.
    fn ensure_bound(&self, request: &CognitionWriteAcquire) -> CoordinationResult<bool> {
        match busy_as_none(read_known_coordinator_for_acquire(&request.lock_path))? {
            None => return Ok(false),
            Some(Some(_)) => {}
            Some(None) => {
                initialize_coordinator(&request.lock_path, self.pid, &self.host)?;
            }
        }
        let initialized =
            match busy_as_none(read_known_coordinator_for_acquire(&request.lock_path))? {
                None => return Ok(false),
                Some(meta) => {
                    meta.ok_or_else(|| invalid("coordinator initialization unavailable"))?
                }
            };
        if initialized.fence_sha256.is_none()
            && !bind_coordinator_fence(&request.lock_path, &self.hostname, &self.host)?
        {
            return Ok(false);
        }
        if self.abandoned(request) {
            return Ok(false);
        }
        let verified = match busy_as_none(read_known_coordinator_for_acquire(&request.lock_path))? {
            None => return Ok(false),
            Some(meta) => meta.ok_or_else(|| invalid("coordinator verification unavailable"))?,
        };
        if verified.fence_sha256.is_none() {
            return Err(invalid("coordinator fence unbound"));
        }
        Ok(true)
    }

    /// Opens the coordinator database inside an exclusive transaction.
    fn begin(&self, request: &CognitionWriteAcquire) -> CoordinationResult<Option<Connection>> {
        let Some(connection) = busy_as_none(open_readwrite(&coordinator_path(&request.lock_path)))?
        else {
            return Ok(None);
        };
        if let Err(error) = connection.execute_batch("BEGIN EXCLUSIVE") {
            return if is_busy(&error) {
                Ok(None)
            } else {
                Err(CoordinationError::gate_io(error))
            };
        }
        if self.abandoned(request) {
            let _ = connection.execute_batch("ROLLBACK");
            return Ok(None);
        }
        Ok(Some(connection))
    }

    /// Records this process as the lock owner, after checking the fence is
    /// still the one it was bound to.
    fn register_owner(
        &self,
        connection: &Connection,
        request: &CognitionWriteAcquire,
    ) -> CoordinationResult<(String, LockInfo)> {
        let current = read_coordinator_meta(connection)?
            .filter(|meta| meta.format_version == super::fence::COORDINATOR_VERSION)
            .ok_or_else(|| invalid("coordinator metadata mismatch"))?;
        let known = read_known_coordinator_inside(&request.lock_path, current)?;
        if !known {
            return Err(invalid("coordinator fence changed"));
        }
        let purpose = request
            .purpose
            .as_deref()
            .map(butler_core::public_text::trim_js_whitespace)
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
        write_owner(connection, &owner)?;
        Ok((registration_id, owner))
    }

    fn remove_registration(&self, path: &Path, registration_id: &str) {
        let mut local = self.local.lock();
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
            return Err(invalid("consolidation lease does not own path"));
        }
        Ok(())
    }

    /// Releases the lock; `commit` records whether the writer finished its work.
    pub fn release(mut self, commit: bool) -> CoordinationResult<()> {
        self.finish(commit)
    }

    fn finish(&mut self, commit: bool) -> CoordinationResult<()> {
        let Some(connection) = self.connection.take() else {
            return Ok(());
        };
        // Even a failed writer may have changed a sibling file before rollback.
        self.inner.inventory_revision.fetch_add(1, Ordering::AcqRel);
        let completion = connection.execute_batch(if commit { "COMMIT" } else { "ROLLBACK" });
        let completion_error = completion.err();
        if completion_error.is_some() && commit {
            let _ = connection.execute_batch("ROLLBACK");
        }
        let close_error = connection.close().err().map(|(_, error)| error);
        self.inner
            .remove_registration(&self.lock_path, &self.registration_id);
        self.inner.released.notify_waiters();
        if let Some(error) = completion_error {
            return Err(sqlite_error(error));
        }
        if let Some(error) = close_error {
            return Err(CoordinationError::gate_io(error));
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
    let bytes = std::fs::read(lock_path).map_err(CoordinationError::gate_io)?;
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

/// A busy coordinator reads as `None`; other errors pass through.
fn busy_as_none<T>(result: CoordinationResult<T>) -> CoordinationResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.is_busy() => Ok(None),
        Err(error) => Err(error),
    }
}
