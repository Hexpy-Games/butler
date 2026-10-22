//! Process-owned, change-driven cutover. Each transaction releases BTCC's lane
//! before the next source, leaving Tier 0 reads and turns available during import.
use butler_ledger::project_ledger::ProjectWork;
use butler_turn::btcc::{BtccError, BtccStorage, ResolvedProjectWorkScope};
use butler_work::{
    cutover::{self, CutoverState},
    store,
};
use rusqlite::{OpenFlags, OptionalExtension};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(super) struct CutoverOwner {
    stop: CancellationToken,
    tasks: TaskTracker,
    ready: Arc<tokio::sync::Notify>,
}
impl CutoverOwner {
    pub(super) fn ready(&self) -> Arc<tokio::sync::Notify> {
        self.ready.clone()
    }
    pub(super) async fn close(&self) {
        self.stop.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }
}
impl Drop for CutoverOwner {
    fn drop(&mut self) {
        self.stop.cancel();
        self.tasks.close();
    }
}
pub(super) async fn start(
    root: PathBuf,
    storage: BtccStorage,
    project: Arc<ProjectWork>,
    stop: &CancellationToken,
) -> Result<CutoverOwner, BtccError> {
    storage
        .work_model_write(move |tx| cutover::begin(tx, CutoverState::Pending))
        .await
        .map_err(BtccError::from)?;
    storage
        .fence_legacy_work_writers()
        .await
        .map_err(BtccError::from)?;
    let owner = CutoverOwner {
        stop: stop.child_token(),
        tasks: TaskTracker::new(),
        ready: Arc::new(tokio::sync::Notify::new()),
    };
    let stopping = owner.stop.clone();
    let ready = owner.ready.clone();
    owner.tasks.spawn(async move {
        tokio::select! { () = ready.notified() => {}, () = stopping.cancelled() => return }
        if let Err(error) = run(root, storage, project, stopping.clone()).await {
            // Codes only: source paths and document contents never reach logs.
            if !stopping.is_cancelled() {
                butler_core::diagnostic!("[work-cutover] failed code={}", error.code());
            }
        }
    });
    Ok(owner)
}
async fn run(
    root: PathBuf,
    storage: BtccStorage,
    project: Arc<ProjectWork>,
    stop: CancellationToken,
) -> Result<(), BtccError> {
    let epoch = storage
        .work_model_read(|db| {
            Ok(db.query_row(butler_work::cutover::EPOCH, [], |r| r.get::<_, i64>(0))?)
        })
        .await
        .map_err(BtccError::from)?;
    let backup = if epoch == 0 {
        prepare_backup(root.clone(), &storage, stop.clone()).await?
    } else {
        CutoverState::Done
    };
    let active = storage
        .work_model_write(move |tx| cutover::resume(tx, backup))
        .await
        .map_err(BtccError::from)?;
    if !active {
        return Ok(());
    }
    if epoch == 0 {
        observe(&root, &storage, &project, &stop).await?;
    }
    while !stop.is_cancelled() {
        let more = storage
            .work_model_write(|tx| cutover::batch(tx, &context()))
            .await
            .map_err(BtccError::from)?;
        if !more {
            break;
        }
    }
    Ok(())
}
async fn prepare_backup(
    root: PathBuf,
    storage: &BtccStorage,
    stop: CancellationToken,
) -> Result<CutoverState, BtccError> {
    storage
        .work_model_write(|tx| {
            tx.execute(cutover::BACKING_UP, [])?;
            Ok(())
        })
        .await
        .map_err(BtccError::from)?;
    // Pre-import image, after this build's native schema migrations. It is
    // deliberately not a byte-for-byte pre-upgrade copy of the data folder.
    let result = tokio::task::spawn_blocking(move || {
        cutover::prepare_with_cancel(&root, &|| stop.is_cancelled())
    })
    .await;
    let (code, error) = match result {
        Ok(Ok(state)) => return Ok(state),
        Ok(Err(error)) => (
            cutover::BackupFailureCode::Copy,
            BtccError::relayed("work_cutover_backup", error.to_string()),
        ),
        Err(error) => (
            cutover::BackupFailureCode::Worker,
            BtccError::relayed("work_cutover_backup_worker", error.to_string()),
        ),
    };
    storage
        .work_model_write(move |tx| cutover::fail_backup(tx, code))
        .await
        .map_err(BtccError::from)?;
    Err(error)
}

fn context() -> store::Context {
    store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: serde_json::json!({"origin":"migration"}),
    }
}
async fn observe(
    root: &std::path::Path,
    storage: &BtccStorage,
    project: &ProjectWork,
    stop: &CancellationToken,
) -> Result<(), BtccError> {
    let mut after = String::new();
    while !stop.is_cancelled() {
        let db = root.join("app-server/butler-client.sqlite");
        let cursor = after.clone();
        let next = tokio::task::spawn_blocking(move || project_batch(db, &cursor))
            .await
            .map_err(|e| BtccError::relayed("work_cutover_app_reader", e.to_string()))??;
        let Some((id, ledger_id, sessions)) = next else {
            break;
        };
        after = id.clone();
        if !valid_component(&ledger_id) {
            unresolved(storage, vec![serde_json::json!({"source":"ledger_project","id":id,"code":"invalid_project_id"})]).await?;
            continue;
        }
        let scope = ResolvedProjectWorkScope {
            app_project_id: id.clone(),
            ledger_project_id: ledger_id.clone(),
            ledger_root: root.join("project-ledger/projects").join(ledger_id),
        };
        let result = project
            .observe_for_cutover(scope, sessions, |input| {
                let storage = storage.clone();
                async move {
                    storage
                        .observe_work_model_cutover(input)
                        .await
                        .map_err(BtccError::from)
                }
            })
            .await;
        let needs = match result {
            Ok(needs) => needs,
            Err(error) => {
                vec![serde_json::json!({"source":"ledger_project","id":id,"code":error.code()})]
            }
        };
        unresolved(storage, needs).await?;
    }
    Ok(())
}
fn valid_component(value: &str) -> bool {
    let mut parts = std::path::Path::new(value).components();
    matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none()
}
type ProjectBatch = Option<(String, String, BTreeSet<String>)>;
fn project_batch(path: PathBuf, after: &str) -> Result<ProjectBatch, BtccError> {
    let read = || -> rusqlite::Result<ProjectBatch> {
        let db = butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        // Startup-only App inventory, keyset by primary key. Never used by a
        // request or an idle poll; one project's sessions are read once.
        let row = db
            .query_row(butler_work::cutover::APP_PROJECT_BATCH, [after], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()?;
        let Some((id, ledger)) = row else {
            return Ok(None);
        };
        let rows = db
            .prepare(butler_work::cutover::APP_SESSIONS)?
            .query_map([&id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut sessions = BTreeSet::new();
        for (chat, hint) in rows {
            if let Some(hint) = hint {
                sessions.insert(hint);
            } else {
                sessions.insert(butler_gateway::gateway::app_session_hint(&chat));
                sessions.insert(chat);
            }
        }
        Ok(Some((id, ledger, sessions)))
    };
    read().map_err(|e| BtccError::relayed("work_cutover_app_inventory", e.to_string()))
}
async fn unresolved(storage: &BtccStorage, items: Vec<serde_json::Value>) -> Result<(), BtccError> {
    for item in items {
        storage
            .work_model_write(move |tx| {
                cutover::needs_source(
                    tx,
                    item["source"].as_str().unwrap_or("ledger"),
                    item["id"].as_str().unwrap_or(""),
                    item["code"].as_str().unwrap_or("unreadable_source"),
                )
            })
            .await
            .map_err(BtccError::from)?;
    }
    Ok(())
}
