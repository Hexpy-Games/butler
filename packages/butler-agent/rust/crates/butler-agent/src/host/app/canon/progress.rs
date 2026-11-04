//! Read Ledger-owned Work on its bounded blocking lane, outside canon writers.
use super::*;
use butler_ledger::project_ledger::{ProjectLedger, ProjectWorkPlanRead};
use store::runtime::ProjectViews;

#[derive(Clone)]
pub(super) struct ProjectReader {
    ledger: ProjectLedger,
    unreadable: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}
impl ProjectReader {
    pub(super) fn new(ledger: ProjectLedger) -> Self {
        Self {
            ledger,
            unreadable: Arc::default(),
        }
    }
    fn observed(&self, id: &str, failure: Option<String>) {
        let Ok(mut unreadable) = self.unreadable.lock() else {
            return;
        };
        if let Some(error) = failure {
            if unreadable.insert(id.to_owned()) {
                butler_core::diagnostic!("Canon project Work read failed work_id={id}: {error}");
            }
        } else {
            unreadable.remove(id);
        }
    }
}

pub(super) async fn views(
    reader: &ProjectReader,
    works: Vec<Value>,
) -> Result<ProjectViews, GatewayApplicationError> {
    let mut views = ProjectViews::new();
    for work in works {
        let Some(id) = work["work_id"].as_str() else {
            continue;
        };
        if work["scope_kind"] != "project" || views.contains_key(id) {
            continue;
        }
        let input = ProjectWorkPlanRead {
            app_project_id: work["scope_ref"].as_str().unwrap_or_default().to_owned(),
            ledger_project_id: work["ledger_project_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            work_id: id.to_owned(),
        };
        let view = match reader.ledger.read_project_work_view(input).await {
            Ok(view) => view,
            Err(error) => {
                reader.observed(id, Some(error.to_string()));
                continue;
            }
        };
        reader.observed(id, view.is_none().then(|| "Work view missing".to_owned()));
        if let Some(view) = view {
            views.insert(
                id.to_owned(),
                serde_json::to_value(view).map_err(GatewayApplicationError::internal_from)?,
            );
        }
    }
    Ok(views)
}

pub(super) async fn enrich(
    storage: &BtccStorage,
    reader: &ProjectReader,
    value: Value,
) -> Result<Value, GatewayApplicationError> {
    let copy = value.clone();
    let works = storage
        .canon_read(move |db| store::runtime::project_works(db, &copy))
        .await
        .map_err(error)?;
    let views = views(reader, works).await?;
    storage
        .canon_read(move |db| {
            let mut value = value;
            if let Some(id) = value.get("epic_id").and_then(Value::as_str) {
                return store::runtime::progress(db, id, &views);
            }
            store::runtime::enrich(db, &mut value, &views)?;
            Ok(value)
        })
        .await
        .map_err(error)
}

pub(super) async fn reconcile(
    storage: BtccStorage,
    reader: ProjectReader,
    after: Arc<std::sync::atomic::AtomicI64>,
) -> Result<(), GatewayApplicationError> {
    reconcile_batch(&storage, &reader, &after).await?;
    Ok(())
}

/// Keyset batches until the feed is empty, bounded so a busy feed cannot hold a caller.
pub(super) async fn catch_up(
    storage: &BtccStorage,
    reader: &ProjectReader,
    after: &Arc<std::sync::atomic::AtomicI64>,
) -> Result<(), GatewayApplicationError> {
    for _ in 0..16 {
        if !reconcile_batch(storage, reader, after).await? {
            break;
        }
    }
    Ok(())
}

/// Whether the batch had anything to read.
async fn reconcile_batch(
    storage: &BtccStorage,
    reader: &ProjectReader,
    after: &Arc<std::sync::atomic::AtomicI64>,
) -> Result<bool, GatewayApplicationError> {
    use std::sync::atomic::Ordering;
    let cursor = after.load(Ordering::Relaxed);
    let mut batch = storage
        .canon_read(move |db| store::runtime::prepare(db, cursor))
        .await
        .map_err(error)?;
    if batch.is_empty() {
        return Ok(false);
    }
    let views = views(reader, std::mem::take(&mut batch.works)).await?;
    let next = storage
        .canon_write(move |tx| {
            store::runtime::catch_up(
                tx,
                &store::runtime_context(chrono::Utc::now().timestamp_millis()),
                &views,
                cursor,
                batch,
            )
        })
        .await
        .map_err(error)?;
    for (row, error) in next.diagnostics {
        tracing::warn!(%error, %row, "Canon reconcile row quarantined");
    }
    after.store(next.after, Ordering::Relaxed);
    Ok(true)
}
