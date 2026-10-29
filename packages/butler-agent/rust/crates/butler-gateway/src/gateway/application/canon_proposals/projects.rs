//! Durable hidden project reservation. Canon's proposal receipt is the commit point.
use super::*;
use rusqlite::{OptionalExtension, params};

pub(super) async fn prepare(
    app: &AppApplication,
    id: &str,
    row: &Value,
    by: Option<&str>,
) -> Result<String, GatewayApplicationError> {
    let Some(name) = row["document"]["new_name"].as_str() else {
        let project = field(row, "project_id")?;
        let checked = project.clone();
        let exists = app
            .storage
            .read(move |db| {
                super::super::projects::rows::active_by_id(db, &checked).map(|p| p.is_some())
            })
            .await
            .map_err(app_error)?;
        if !exists {
            return Err(public(404, "project_not_found", "Project not found."));
        }
        return Ok(project);
    };
    let name = super::super::projects::validate_branch_name(name)?;
    let project = format!("project-canon-{id}");
    let workspace = app.project_creation.workspace_root().join(&project);
    let (id, project_copy, workspace_text) = (
        id.to_owned(),
        project.clone(),
        workspace.to_string_lossy().into_owned(),
    );
    let reservation = id.clone();
    let by = by.map(str::to_owned);
    let now = app.dependencies.identity_clock.now_iso();
    app.storage
        .execute(move |db| {
            db.execute(
                "INSERT OR IGNORE INTO app_canon_proposal_projects(proposal_id,project_id,name,workspace,created_at,resolved_by) VALUES(?1,?2,?3,?4,?5,?6)",
                params![id, project_copy, name, workspace_text, now, by],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .map_err(app_error)?;
    let created = tokio::task::spawn_blocking(move || {
        if let Some(parent) = workspace.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::create_dir(workspace) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?
    .map_err(GatewayApplicationError::internal_from)?;
    if created {
        let id = reservation;
        app.storage.execute(move |db| {
            db.execute("UPDATE app_canon_proposal_projects SET workspace_created=1 WHERE proposal_id=?1", [id]).map_err(AppStorageError::sqlite)?;
            Ok(())
        }).await.map_err(app_error)?;
    }
    Ok(project)
}
pub(super) async fn finish(
    app: &AppApplication,
    id: &str,
    success: bool,
) -> Result<(), GatewayApplicationError> {
    let id = id.to_owned();
    let clock = app.dependencies.identity_clock.clone();
    let subs = app.subscribers.clone();
    let cleanup = app.storage.execute(move |db| {
        let mut cleanup = None;
        let tx=db.savepoint().map_err(AppStorageError::sqlite)?;
        let row:Option<(String,String,String,String,bool)>=tx.query_row("SELECT project_id,name,workspace,created_at,workspace_created FROM app_canon_proposal_projects WHERE proposal_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(AppStorageError::sqlite)?;
        if let Some((project,name,workspace,created,workspace_created))=row {
            if success {
                tx.execute("INSERT OR IGNORE INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,ledger_project_id,created_at,updated_at) VALUES(?1,?2,'active',?3,?2,?2,?1,?4,?4)",params![project,name,workspace,created]).map_err(AppStorageError::sqlite)?;
                let row=super::super::projects::rows::active_by_id(&tx,&project)?.ok_or_else(||AppStorageError::new(super::super::storage::AppStorageCode::ProjectCreationFailed,"Project missing"))?;
                let summary=super::super::projects::rows::summary(row,None);
                events::append(&tx,&subs,"project.created",None,service::map(&json!({"project":summary}))?,&clock.now_iso())?;
            }
            if !success && workspace_created { cleanup = Some(workspace); }
            tx.execute("DELETE FROM app_canon_proposal_projects WHERE proposal_id=?1",[id]).map_err(AppStorageError::sqlite)?;
        }
        tx.commit().map_err(AppStorageError::sqlite)?;
        Ok(cleanup)
    }).await.map_err(app_error)?;
    if let Some(workspace) = cleanup {
        tokio::task::spawn_blocking(move || match std::fs::remove_dir(workspace) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)?;
    }
    Ok(())
}
pub(in crate::gateway::application) async fn recover(
    app: &AppApplication,
) -> Result<(), GatewayApplicationError> {
    let ids = app
        .storage
        .read(|db| {
            db.prepare("SELECT proposal_id,resolved_by FROM app_canon_proposal_projects ORDER BY proposal_id")
                .map_err(AppStorageError::sqlite)?
                .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))
                .map_err(AppStorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    for (id, by) in ids {
        let serial = app
            .canon_projection_locks
            .acquire(format!("proposal:{id}"))
            .await;
        let row = app
            .dependencies
            .canon
            .proposal("raw".into(), json!({"id":id}))
            .await?;
        if row["state"] == "applied" {
            finish(app, &id, true).await?;
        } else if row["state"] == "open" {
            drop(serial);
            super::resolve(app, json!({"id":id,"outcome":"accepted","by":by})).await?;
        } else {
            finish(app, &id, false).await?;
        }
    }
    Ok(())
}
