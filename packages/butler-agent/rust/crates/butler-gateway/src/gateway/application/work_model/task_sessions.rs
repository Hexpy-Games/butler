//! Recoverable App projections. One App transaction precedes each BTCC ack.
pub(super) mod sql;
use super::*;
use rusqlite::{OptionalExtension, params};
use serde_json::json;

pub(super) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.work_model.changes() else {
        return;
    };
    let app = app.clone_handle();
    tokio::spawn(async move {
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
        if row["kind"] == "task_continue" {
            continue_here(app, &row).await?;
            app.dependencies.work_model.task_session_applied(op).await?;
            continue;
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
    if row["kind"] == "ownership_prompt" {
        return prompt(db, row);
    }
    if row["kind"] == "ownership_taken" {
        return resolve_prompt(db, p);
    }
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
            row["op_id"].as_str()
        ],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}
fn prompt(db: &rusqlite::Connection, row: &Value) -> Result<(), AppStorageError> {
    let mut p = row["payload"].clone();
    let session =
        sessions::identity::resolve_owner(db, p["target_session_id"].as_str().unwrap_or_default())?
            .unwrap_or_default();
    let owner =
        sessions::identity::resolve_owner(db, p["session_id"].as_str().unwrap_or_default())?
            .unwrap_or_else(|| p["session_id"].as_str().unwrap_or_default().into());
    let chat: Option<String> = db
        .query_row(sql::CHAT_TITLE, [&owner], |r| r.get(0))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let task = p["title"].as_str().unwrap_or_default().to_owned();
    let particle = subject_particle(&task);
    let progress = if p["state"] == "running" {
        "진행 중입니다"
    } else {
        "진행 예정입니다"
    };
    p["message"] = json!(format!(
        "‘{task}’{particle} ‘{}’ 대화에서 {progress}. 여기서 할까요?",
        chat.as_deref().unwrap_or(&task)
    ));
    let chat_title = chat.as_deref().unwrap_or(&task);
    p["message_en"] = json!(if p["state"] == "running" {
        format!("‘{task}’ is running in ‘{chat_title}’. Do it here?")
    } else {
        format!("‘{task}’ is planned in ‘{chat_title}’. Do it here?")
    });
    p["actions"] = json!([{"decision":"open","label":"그 대화 열기","label_en":"Open that chat","session_id":owner},{"decision":"take_here","label":"여기서 하기","label_en":"Do it here","primary":true}]);
    db.execute(
        sql::INSERT_PROMPT,
        params![
            row["op_id"].as_str(),
            session,
            p["task_id"].as_str(),
            p.to_string()
        ],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}
fn subject_particle(title: &str) -> &'static str {
    match title.trim_end().chars().last().map(u32::from) {
        Some(c) if (0xac00..=0xd7a3).contains(&c) && (c - 0xac00) % 28 != 0 => "은",
        _ => "는",
    }
}

pub(super) fn decisions(
    db: &rusqlite::Connection,
    session: &str,
) -> Result<Value, AppStorageError> {
    let chat = sessions::identity::resolve_owner(db, session)?.unwrap_or_default();
    let rows = db
        .prepare(sql::PENDING_PROMPTS)
        .map_err(AppStorageError::sqlite)?
        .query_map([chat], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppStorageError::sqlite)?;
    let mut result = Vec::new();
    for (id, payload) in rows {
        let mut value: Value = serde_json::from_str(&payload).map_err(|error| {
            AppStorageError::sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
        })?;
        value["id"] = json!(id);
        result.push(value);
    }
    Ok(json!(result))
}

fn resolve_prompt(db: &rusqlite::Connection, p: &Value) -> Result<(), AppStorageError> {
    let chat =
        sessions::identity::resolve_owner(db, p["target_session_id"].as_str().unwrap_or_default())?
            .unwrap_or_default();
    db.execute(sql::RESOLVE_PROMPT, params![chat, p["task_id"].as_str()])
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

async fn continue_here(app: &AppApplication, row: &Value) -> Result<(), GatewayApplicationError> {
    let p = &row["payload"];
    let owner = p["session_id"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?
        .to_owned();
    let chat = app.owner_chat(owner).await?;
    app.send(crate::gateway::SendMessageCommand {
        chat_id: chat,
        request: crate::gateway::MessageSendRequest {
            text: Some(p["text"].clone()),
            client_message_id: Some(row["op_id"].clone()),
            ..Default::default()
        },
    })
    .await?;
    Ok(())
}
