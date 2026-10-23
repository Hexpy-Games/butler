//! Recoverable App projections. One App transaction precedes each BTCC ack.
pub(in crate::gateway::application) mod sql;
use super::*;
use rusqlite::{OptionalExtension, params};

pub(super) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.work_model.changes() else {
        return;
    };
    let app = app.clone_handle();
    tokio::spawn(async move {
        if let Err(error) = backfill(&app).await {
            tracing::error!(%error,"Task session coordinator recovery failed");
        }
        loop {
            changes.borrow_and_update();
            if let Err(error) = drain(&app).await {
                tracing::error!(%error,"Task session projection failed");
            }
            tokio::select! {
                ()=app.dependencies.service_shutdown.cancelled()=>return,
                result=changes.changed()=>if result.is_err(){return;}
            }
        }
    });
}
pub(super) async fn drain(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    for row in app
        .dependencies
        .work_model
        .pending_task_session_intents()
        .await?
    {
        let op = row["op_id"]
            .as_str()
            .ok_or_else(GatewayApplicationError::internal)?
            .to_owned();
        if let Err(error) = apply(app, row, op).await {
            tracing::error!(%error,"Task session intent failed; retained for the next change");
        }
    }
    Ok(())
}
fn project(
    db: &rusqlite::Connection,
    subs: &EventSubscribers,
    clock: &dyn AppIdentityClock,
    row: &Value,
) -> Result<(), AppStorageError> {
    let p = &row["payload"];
    let session = p["session_id"].as_str().unwrap_or_default();
    let exists: bool = db
        .query_row(sql::PROJECTED, [row["op_id"].as_str()], |r| r.get(0))
        .map_err(AppStorageError::sqlite)?;
    if exists {
        return Ok(());
    }
    let project = coordinator_project(db, p)?;
    let present: bool = db
        .query_row(sql::CHAT_EXISTS, [session], |r| r.get(0))
        .map_err(AppStorageError::sqlite)?;
    if !present {
        sessions::create_branch_session(
            db,
            subs,
            &AppCreateSessionInput {
                kind: if project.is_some() {
                    AppChatKind::Project
                } else {
                    AppChatKind::Chat
                },
                title: p["title"].as_str().map(str::to_owned),
                project_id: project,
                session_hint: Some(session.into()),
                group_id: None,
            },
            clock,
        )?;
    }
    db.execute(sql::BIND_CHAT, [session])
        .map_err(AppStorageError::sqlite)?;
    db.execute(sql::REMOVE_NODE, [session])
        .map_err(AppStorageError::sqlite)?;
    db.execute(
        sql::INSERT_SESSION,
        params![
            session,
            p["task_id"].as_str(),
            p["work_id"].as_str(),
            row["op_id"].as_str(),
            sessions::identity::resolve_owner(
                db,
                p["coordinator_session"].as_str().unwrap_or_default()
            )?
        ],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}
fn coordinator_project(
    db: &rusqlite::Connection,
    p: &Value,
) -> Result<Option<String>, AppStorageError> {
    let coordinator = sessions::identity::resolve_owner(
        db,
        p["coordinator_session"].as_str().unwrap_or_default(),
    )?;
    let project: Option<String> = db
        .query_row(sql::COORDINATOR_PROJECT, [coordinator], |r| r.get(0))
        .optional()
        .map_err(AppStorageError::sqlite)?
        .flatten();
    Ok(project)
}

async fn apply(
    app: &AppApplication,
    row: Value,
    op: String,
) -> Result<(), GatewayApplicationError> {
    if row["kind"] == "task_continue" {
        let p = &row["payload"];
        let owner = p["session_id"]
            .as_str()
            .ok_or_else(GatewayApplicationError::internal)?
            .to_owned();
        let chat = app.owner_chat(owner).await?;
        let instruction = p["instruction_id"]
            .as_str()
            .ok_or_else(GatewayApplicationError::internal)?
            .to_owned();
        app.send_runtime_instruction(chat, instruction).await?;
        return app.dependencies.work_model.task_session_applied(op).await;
    }
    let subs = app.subscribers.clone();
    let clock = app.dependencies.identity_clock.clone();
    app.storage
        // The App writer wraps this operation in its transaction/savepoint;
        // completion is returned only after that transaction commits.
        .execute(move |db| project(db, &subs, clock.as_ref(), &row))
        .await
        .map_err(app_error)?;
    app.dependencies.work_model.task_session_applied(op).await?;
    Ok(())
}

async fn backfill(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    let sessions = app
        .storage
        .read(|db| {
            db.prepare(sql::UNBOUND_SESSIONS)
                .map_err(AppStorageError::sqlite)?
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(AppStorageError::sqlite)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    if sessions.is_empty() {
        return Ok(());
    }
    let states = app
        .dependencies
        .work_model
        .task_session_states(sessions)
        .await?;
    app.storage
        .execute(move |db| {
            for row in states {
                db.execute(
                    sql::BIND_COORDINATOR,
                    params![row["session_id"].as_str(), row["home_session_id"].as_str()],
                )
                .map_err(AppStorageError::sqlite)?;
            }
            Ok(())
        })
        .await
        .map_err(app_error)
}
