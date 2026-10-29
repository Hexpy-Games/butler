//! Atomic private notes, serialized with other consolidation writers.
use super::{PatternError, types::*};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
/// Private durable pattern notes under the shared cognition write lease.
pub struct PatternRepository {
    root: PathBuf,
    coordinator: Arc<CognitionWriteCoordinator>,
    changed: Arc<tokio::sync::Notify>,
}
impl PatternRepository {
    /// Bind the repository to the data root and its write coordinator.
    pub fn new(root: PathBuf, coordinator: Arc<CognitionWriteCoordinator>) -> Self {
        Self {
            root,
            coordinator,
            changed: Arc::new(tokio::sync::Notify::new()),
        }
    }
    /// Cheap signal for a newly committed proposal bundle.
    pub fn proposals_changed(&self) -> Arc<tokio::sync::Notify> {
        self.changed.clone()
    }
    pub(super) async fn load(&self) -> Result<PatternStore, PatternError> {
        let path = self.path();
        tokio::task::spawn_blocking(move || load(&path))
            .await
            .map_err(PatternError::worker)?
    }
    fn path(&self) -> PathBuf {
        self.root.join("cognition/patterns/patterns.json")
    }
    pub(super) async fn commit(
        &self,
        mut store: PatternStore,
        expected: u64,
        cancellation: &CancellationToken,
    ) -> Result<(), PatternError> {
        let new_bundle = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let committed = new_bundle.clone();
        self.mutate(expected, cancellation, move |current| {
            committed.store(
                store
                    .bundles
                    .iter()
                    .any(|b| !current.bundles.iter().any(|old| old.id == b.id)),
                std::sync::atomic::Ordering::Relaxed,
            );
            store.revision = current.revision;
            *current = store;
            Ok(())
        })
        .await?;
        if new_bundle.load(std::sync::atomic::Ordering::Relaxed) {
            self.changed.notify_one();
        }
        Ok(())
    }
    async fn mutate(
        &self,
        expected: u64,
        cancellation: &CancellationToken,
        change: impl FnOnce(&mut PatternStore) -> Result<(), PatternError> + Send + 'static,
    ) -> Result<(), PatternError> {
        let lock = self
            .root
            .join("cognition/consolidation/locks/consolidation.lock");
        let mut request = CognitionWriteAcquire::immediate(lock, "consolidation");
        request.cancellation = Some(cancellation.clone());
        let lease = self
            .coordinator
            .acquire(request, CognitionWaitClass::Background)
            .await
            .map_err(PatternError::coordination)?
            .ok_or(PatternError::Busy)?;
        let path = self.path();
        let token = cancellation.clone();
        tokio::task::spawn_blocking(move || {
            let result = (|| {
                let mut current = load(&path)?;
                if current.revision != expected {
                    return Err(PatternError::Conflict);
                }
                change(&mut current)?;
                super::ensure_active(&token)?;
                current.revision += 1;
                save(&path, &current)
            })();
            lease
                .release(result.is_ok())
                .map_err(PatternError::coordination)?;
            result
        })
        .await
        .map_err(PatternError::worker)?
    }
    /// Read active notes, most recently updated first, on a blocking worker.
    pub async fn view(&self) -> Result<Value, PatternError> {
        let mut store = self.load().await?;
        store
            .patterns
            .sort_by_key(|p| std::cmp::Reverse(p.updated_at));
        Ok(
            json!({"revision":store.revision,"patterns":store.patterns.iter().map(|p|
            json!({"id":p.id,"title":p.title,"intent":p.intent,"window":p.window,
                "evidence":p.evidence,"proposed":p.proposed_at.is_some()})).collect::<Vec<_>>()}),
        )
    }
    /// Read bundles containing at least one pending candidate.
    pub async fn proposals(&self) -> Result<Value, PatternError> {
        let store = self.load().await?;
        Ok(
            json!({"revision":store.revision,"bundles":store.bundles.into_iter().filter(|b|
            b.candidates.iter().any(|c| c.state == "pending")).collect::<Vec<_>>()}),
        )
    }
    /// Tombstone a user-selected pattern and decline its pending candidates.
    pub async fn delete(
        &self,
        id: String,
        expected: u64,
        now: DateTime<Utc>,
        cancellation: &CancellationToken,
    ) -> Result<(), PatternError> {
        self.mutate(expected, cancellation, move |s| {
            remove(s, &id, "deleted", now)
        })
        .await
    }
    /// Record a revision-checked choice without creating a schedule.
    pub async fn decide(
        &self,
        bundle: String,
        pattern: String,
        decision: String,
        expected: u64,
        now: DateTime<Utc>,
        cancellation: &CancellationToken,
    ) -> Result<(), PatternError> {
        if !matches!(decision.as_str(), "accepted" | "declined") {
            return Err(PatternError::InvalidDecision);
        }
        self.mutate(expected, cancellation, move |s| {
            let candidate = s
                .bundles
                .iter_mut()
                .find(|b| b.id == bundle)
                .and_then(|b| b.candidates.iter_mut().find(|c| c.pattern_id == pattern))
                .ok_or(PatternError::NotFound)?;
            if candidate.state != "pending" {
                return Err(PatternError::Conflict);
            }
            candidate.state = decision.clone();
            if decision == "declined" {
                remove(s, &pattern, "declined", now)?;
            }
            Ok(())
        })
        .await
    }
}
fn remove(
    store: &mut PatternStore,
    id: &str,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), PatternError> {
    let index = store
        .patterns
        .iter()
        .position(|p| p.id == id)
        .ok_or(PatternError::NotFound)?;
    let p = store.patterns.remove(index);
    store.removed.push(Removed {
        id: p.id,
        title: p.title,
        intent: p.intent,
        window: p.window,
        reason: reason.into(),
        removed_at: now,
    });
    for candidate in store.bundles.iter_mut().flat_map(|b| &mut b.candidates) {
        if candidate.pattern_id == id && candidate.state == "pending" {
            candidate.state = "declined".into();
        }
    }
    Ok(())
}
fn load(path: &Path) -> Result<PatternStore, PatternError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(PatternStore::default()),
        Err(e) => return Err(PatternError::io(e)),
    };
    let store: PatternStore = serde_json::from_slice(&bytes).map_err(PatternError::encoding)?;
    if store.schema != "butler.cognition.patterns.v1" {
        return Err(PatternError::InvalidStore);
    }
    Ok(store)
}
fn save(path: &Path, store: &PatternStore) -> Result<(), PatternError> {
    let parent = path.parent().ok_or(PatternError::InvalidStore)?;
    butler_platform::secure_fs::create_private_dir_all(parent).map_err(PatternError::io)?;
    let bytes = serde_json::to_vec_pretty(store).map_err(PatternError::encoding)?;
    butler_platform::secure_fs::replace_private(
        path,
        |file| file.write_all(&bytes).map_err(PatternError::io),
        PatternError::io,
    )
}
