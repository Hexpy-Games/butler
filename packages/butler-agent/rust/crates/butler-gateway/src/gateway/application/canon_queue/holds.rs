use super::*;

pub(super) async fn apply(
    app: &AppApplication,
    op: &str,
    kind: String,
    mut panel: Value,
) -> Result<(), GatewayApplicationError> {
    let pending = panel["state"].is_null() || panel["state"] == "pending";
    let epic_id = field(&panel, "epic_id")?;
    // A replay may already have read this intent when deletion committed. Never
    // restore actionable buttons after the terminal projection has settled it.
    match app
        .dependencies
        .canon
        .project_scope(AppCanonResource::Epic, epic_id.clone())
        .await
    {
        Err(GatewayApplicationError::Public { status: 404, .. }) => {
            if pending {
                panel["state"] = json!("deleted");
            }
        }
        Err(error) => return Err(error),
        Ok(_) => {}
    }
    #[cfg(feature = "e2e-fixtures")]
    if pending {
        super::super::canon::hold(app, "canon_panel_projection").await?;
    }
    let _projection = app
        .canon_projection_locks
        .acquire(format!("canon-epic-projection:{epic_id}"))
        .await;
    post_panel(app, op, kind, panel, pending).await
}

async fn post_panel(
    app: &AppApplication,
    op: &str,
    kind: String,
    mut panel: Value,
    pending: bool,
) -> Result<(), GatewayApplicationError> {
    let Some(chat) = existing_chat(app, field(&panel, "session_id")?).await? else {
        return Ok(());
    };
    panel["session_id"] = json!(chat);
    panel["kind"] = json!(kind);
    if let Some(other) = panel["other_session_id"].as_str() {
        let other = match existing_chat(app, other.to_owned()).await? {
            Some(chat) => chat,
            None if panel["state"] == "deleted" => app.owner_chat(other.to_owned()).await?,
            None => return Ok(()),
        };
        panel["other_session_id"] = json!(other);
    }
    let text = panel_text(app, &kind, &panel).await?;
    let source = panel["source_key"].as_str().unwrap_or(op).to_owned();
    panel
        .as_object_mut()
        .ok_or_else(GatewayApplicationError::internal)?
        .remove("source_key");
    let payload = json!({"panel":panel});
    let id = format!(
        "canon-panel-{}",
        butler_turn::btcc::digest_identity(&source)
    );
    let now = app.dependencies.identity_clock.now_iso();
    let subscribers = app.subscribers.clone();
    app.storage
        .execute(move |db| {
            let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1)", [&chat], |r|r.get(0)).map_err(AppStorageError::sqlite)?;
            if !exists { return Ok(()); }
            super::super::initiated::enqueue_canon(
                db,
                (&id, &chat),
                &source,
                &kind,
                &text,
                &payload,
                &now,
            )?;
            // A stale pending snapshot must never reopen or relabel a settled card.
            if pending && db.query_row("SELECT COALESCE(json_extract(payload_json,'$.panel.state'),'pending')<>'pending' FROM app_initiated_messages WHERE source_key=?1", [&source], |r|r.get::<_,bool>(0)).map_err(AppStorageError::sqlite)? {
                return Ok(());
            }
            let terminal_text = (payload["panel"]["state"] == "deleted").then_some(text.as_str());
            if let Some(event) =
                super::super::initiated::update_canon_payload(db, &source, &payload, terminal_text, &now)?
            {
                events::publish(&subscribers, &event);
            }
            Ok(())
        })
        .await
        .map_err(app_error)?;
    app.automation_wake.notify_one();
    Ok(())
}

async fn panel_text(
    app: &AppApplication,
    kind: &str,
    panel: &Value,
) -> Result<String, GatewayApplicationError> {
    let language = super::super::canon_proposals::language(app).await?;
    let epic = field(panel, "epic_title")?;
    let text = if panel["state"] == "deleted" {
        if language.starts_with("ko") {
            format!("‘{epic}’ 과제를 삭제했습니다.")
        } else {
            format!("Epic ‘{epic}’ was deleted.")
        }
    } else if kind == "canon_hold" {
        if language.starts_with("ko") {
            format!("‘{epic}’가 막혀 다음 과제를 멈췄습니다.")
        } else {
            format!("‘{epic}’ is blocked. Later epics are on hold.")
        }
    } else {
        let other = field(panel, "other_session_id")?;
        let title = app
            .storage
            .read(move |db| {
                db.query_row("SELECT title FROM chats WHERE id=?1", [other], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        if language.starts_with("ko") {
            format!("‘{epic}’는 ‘{title}’ 대화에서 진행 중입니다(예정입니다). 여기서 할까요?")
        } else {
            format!("‘{epic}’ is running or queued in ‘{title}’. Do it here?")
        }
    };
    Ok(text)
}

async fn existing_chat(
    app: &AppApplication,
    owner: String,
) -> Result<Option<String>, GatewayApplicationError> {
    app.storage
        .read(move |db| sessions::identity::resolve_owner(db, &owner))
        .await
        .map_err(app_error)
}
