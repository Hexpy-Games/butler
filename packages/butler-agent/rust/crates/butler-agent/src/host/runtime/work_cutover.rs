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
    subsessions: Arc<std::sync::OnceLock<Arc<butler_turn::btcc::SubsessionService>>>,
    recovery: super::work_recovery::RecoveryOwner,
}
impl CutoverOwner {
    pub(super) async fn bind_subsessions(
        &self,
        service: Arc<butler_turn::btcc::SubsessionService>,
    ) -> Result<(), BtccError> {
        service
            .recover_native_assignments(self.recovery.interrupted.as_ref().clone())
            .await?;
        let replay = service.clone();
        let stop = self.stop.child_token();
        self.tasks.spawn(async move {
            if let Err(error) = replay.replay_kept_requests(stop).await {
                butler_core::diagnostic!(
                    "[work-cutover] receipt replay failed code={}",
                    error.code()
                );
            }
        });
        let _ = self.subsessions.set(service);
        Ok(())
    }
    pub(super) fn ready(&self) -> Arc<tokio::sync::Notify> {
        self.ready.clone()
    }
    pub(super) async fn close(&self) -> Result<(), BtccError> {
        self.stop.cancel();
        self.tasks.close();
        self.tasks.wait().await;
        self.recovery.close().await
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
        .fence_legacy_work_writers()
        .await
        .map_err(BtccError::from)?;
    let recovery = super::work_recovery::RecoveryOwner::start(storage.clone()).await?;
    let owner = CutoverOwner {
        stop: stop.child_token(),
        tasks: TaskTracker::new(),
        ready: Arc::new(tokio::sync::Notify::new()),
        recovery,
        subsessions: Arc::new(std::sync::OnceLock::new()),
    };
    let subsessions = owner.subsessions.clone();
    let stopping = owner.stop.clone();
    let ready = owner.ready.clone();
    owner.tasks.spawn(async move {
        tokio::select! { () = ready.notified() => {}, () = stopping.cancelled() => return }
        let result = async {
            run(root, storage.clone(), project, stopping.clone()).await?;
            let done = storage
                .work_model_cutover_status()
                .await
                .map_err(BtccError::from)?
                .state
                == CutoverState::Done;
            if done
                && !stopping.is_cancelled()
                && let Some(service) = subsessions.get()
            {
                service.recover_assignments(Vec::new()).await?;
            }
            Ok::<(), BtccError>(())
        }
        .await;
        if let Err(error) = result {
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
            Ok(db
                .query_row(butler_work::cutover::EPOCH, [], |r| r.get::<_, i64>(0))
                .optional()?
                .unwrap_or(0))
        })
        .await
        .map_err(BtccError::from)?;
    let inventory = if epoch == 0 {
        Some(inventory(&root, &project, &stop).await?)
    } else {
        None
    };
    let backup = if let Some(inventory) = &inventory {
        prepare_backup(root.clone(), inventory.clone(), &storage, stop.clone()).await?
    } else {
        CutoverState::Done
    };
    if backup == CutoverState::PostponedNoSpace {
        storage.postpone_work_model_cutover();
        return Ok(());
    }
    let active = storage
        .work_model_write(move |tx| cutover::resume(tx, backup))
        .await
        .map_err(BtccError::from)?;
    if !active {
        return Ok(());
    }
    if let Some(inventory) = inventory {
        observe(&storage, inventory, &stop).await?;
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
async fn observe(
    storage: &BtccStorage,
    inventory: cutover::Inventory,
    stop: &CancellationToken,
) -> Result<(), BtccError> {
    let mut needs = inventory.needs_source;
    for observation in inventory.observations {
        if stop.is_cancelled() {
            return Ok(());
        }
        let input: butler_turn::btcc::ProjectWorkObserveWorks = serde_json::from_value(observation)
            .map_err(|e| BtccError::relayed("work_cutover_inventory", e.to_string()))?;
        let id = input.session_head_work_id.clone();
        if let Err(error) = storage.observe_work_model_cutover(input).await {
            needs.push(serde_json::json!({"source":"ledger_work","id":id,"code":BtccError::from(error).code()}));
        }
    }
    unresolved(storage, needs).await
}
async fn prepare_backup(
    root: PathBuf,
    inventory: cutover::Inventory,
    storage: &BtccStorage,
    stop: CancellationToken,
) -> Result<CutoverState, BtccError> {
    let frozen = inventory.clone();
    let result = match storage
        .work_model_write(move |tx| cutover::freeze_inventory(tx, &frozen))
        .await
    {
        Ok(_) => {
            tokio::task::spawn_blocking(move || {
                cutover::prepare_with_cancel(&root, &inventory, &|| stop.is_cancelled())
            })
            .await
        }
        Err(error) => Ok(Err(std::io::Error::other(BtccError::from(error)))),
    };
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
        .work_model_write(move |tx| {
            cutover::begin(tx, CutoverState::Pending)?;
            cutover::fail_backup(tx, code)
        })
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
async fn inventory(
    root: &std::path::Path,
    project: &ProjectWork,
    stop: &CancellationToken,
) -> Result<cutover::Inventory, BtccError> {
    let data = root.to_owned();
    let frozen = tokio::task::spawn_blocking(move || cutover::frozen_inventory(&data))
        .await
        .map_err(|e| BtccError::relayed("work_cutover_inventory_worker", e.to_string()))?
        .map_err(|e| BtccError::relayed("work_cutover_inventory", e.to_string()))?;
    if let Some(frozen) = frozen {
        return Ok(frozen);
    }
    let records = std::sync::Mutex::new(cutover::Inventory::default());
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
            records.lock().map_err(|e| BtccError::relayed("work_cutover_inventory", e.to_string()))?.needs_source.push(serde_json::json!({"source":"ledger_project","id":id,"code":"invalid_project_id"}));
            continue;
        }
        let scope = ResolvedProjectWorkScope {
            app_project_id: id.clone(),
            ledger_project_id: ledger_id.clone(),
            ledger_root: root.join("project-ledger/projects").join(ledger_id),
        };
        let result = project
            .observe_for_cutover(scope, sessions, |input| {
                let result = freeze(&records, input);
                async move { result }
            })
            .await;
        let needs = match result {
            Ok(needs) => needs,
            Err(error) => {
                vec![serde_json::json!({"source":"ledger_project","id":id,"code":error.code()})]
            }
        };
        records
            .lock()
            .map_err(|e| BtccError::relayed("work_cutover_inventory", e.to_string()))?
            .needs_source
            .extend(needs);
    }
    if stop.is_cancelled() {
        return Err(BtccError::relayed(
            "work_cutover_cancelled",
            "Work cutover stopped",
        ));
    }
    records
        .into_inner()
        .map_err(|e| BtccError::relayed("work_cutover_inventory", e.to_string()))
}
fn freeze(
    records: &std::sync::Mutex<cutover::Inventory>,
    input: butler_turn::btcc::ProjectWorkObserveWorks,
) -> Result<(), BtccError> {
    let mut inventory = records
        .lock()
        .map_err(|e| BtccError::relayed("work_cutover_inventory", e.to_string()))?;
    for item in &input.works {
        for (table, key) in [
            ("btcc_guided_works", &item.work.work_id),
            ("btcc_guided_work_session_heads", &item.work.session_id),
            ("agent_task_graph_changes", &item.work.session_id),
        ] {
            inventory
                .keys
                .entry(table.into())
                .or_default()
                .insert(key.clone());
        }
        for binding in &item.bindings {
            inventory
                .keys
                .entry("btcc_guided_turn_work_bindings".into())
                .or_default()
                .insert(binding.binding_revision_id.clone());
        }
        for result in &item.work.result_refs {
            inventory
                .keys
                .entry("btcc_guided_work_results".into())
                .or_default()
                .insert(result.result_ref.clone());
        }
    }
    inventory.observations.push(
        serde_json::to_value(input)
            .map_err(|e| BtccError::relayed("work_cutover_inventory", e.to_string()))?,
    );
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
