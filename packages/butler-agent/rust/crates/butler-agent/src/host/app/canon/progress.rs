//! Read Ledger-owned Work on its bounded blocking lane, outside canon writers.
use super::*;
use butler_ledger::project_ledger::{ProjectLedger, ProjectWorkPlanRead};
use store::runtime::ProjectViews;

pub(super) async fn views(
    ledger: &ProjectLedger,
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
        let view = match ledger.read_project_work_view(input).await {
            Ok(view) => view,
            Err(error) => {
                tracing::warn!(%error, work_id = id, "Canon project Work read failed");
                continue;
            }
        };
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
    ledger: &ProjectLedger,
    value: Value,
) -> Result<Value, GatewayApplicationError> {
    let copy = value.clone();
    let works = storage
        .canon_read(move |db| store::runtime::project_works(db, &copy))
        .await
        .map_err(error)?;
    let views = views(ledger, works).await?;
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
    ledger: ProjectLedger,
    after: Arc<std::sync::atomic::AtomicI64>,
) -> Result<(), GatewayApplicationError> {
    use std::sync::atomic::Ordering;
    loop {
        let cursor = after.load(Ordering::Relaxed);
        if !storage
            .canon_read(move |db| store::runtime::pending(db, cursor))
            .await
            .map_err(error)?
        {
            return Ok(());
        }
        let works = storage
            .canon_read(move |db| store::runtime::changed_works(db, cursor))
            .await
            .map_err(error)?;
        let views = views(&ledger, works).await?;
        let next = storage
            .canon_write(move |tx| {
                store::runtime::catch_up(
                    tx,
                    &store::runtime_context(chrono::Utc::now().timestamp_millis()),
                    &views,
                    cursor,
                )
            })
            .await
            .map_err(error)?;
        for (row, error) in next.diagnostics {
            tracing::warn!(%error, %row, "Canon reconcile row quarantined");
        }
        after.store(next.after, Ordering::Relaxed);
    }
}
