use super::*;

pub(super) async fn apply(
    app: &AppApplication,
    op: &str,
    kind: String,
    mut panel: Value,
) -> Result<(), GatewayApplicationError> {
    let chat = app.owner_chat(field(&panel, "session_id")?).await?;
    panel["session_id"] = json!(chat);
    panel["kind"] = json!(kind);
    if let Some(other) = panel["other_session_id"].as_str() {
        panel["other_session_id"] = json!(app.owner_chat(other.to_owned()).await?);
    }
    let language = super::super::canon_proposals::language(app).await?;
    let epic = field(&panel, "epic_title")?;
    let text = if kind == "canon_hold" {
        hold_text(&language, &epic, panel["hold_reason"].as_str())
    } else {
        let other = field(&panel, "other_session_id")?;
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
        // Offers stored before the state was recorded still read correctly.
        offer_text(language, &epic, &title, panel["other_running"].as_bool())
    };
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
            super::super::initiated::enqueue_canon(
                db,
                (&id, &chat),
                &source,
                &kind,
                &text,
                &payload,
                &now,
            )?;
            // These answer a run the owner started; waiting for morning would be a silent stall.
            db.execute(
                "UPDATE app_initiated_messages SET bypass_quiet_hours=1 WHERE id=?1",
                [&id],
            )
            .map_err(AppStorageError::sqlite)?;
            if let Some(event) =
                super::super::initiated::update_canon_payload(db, &source, &payload, &now)?
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

fn hold_text(language: &str, epic: &str, reason: Option<&str>) -> String {
    match (
        language.starts_with("ko"),
        reason == Some("step_unfinished"),
    ) {
        (true, true) => {
            format!("‘{epic}’가 끝나지 않아 다음 과제를 멈췄습니다. 답하면 이어서 합니다.")
        }
        (true, false) => format!("‘{epic}’가 막혀 다음 과제를 멈췄습니다."),
        (false, true) => {
            format!("‘{epic}’ isn't finished. Later tasks are on hold. Reply to continue.")
        }
        (false, false) => format!("‘{epic}’ is blocked. Later tasks are on hold."),
    }
}

fn offer_text(language: &str, epic: &str, title: &str, running: Option<bool>) -> String {
    if language.starts_with("ko") {
        let state = match running {
            Some(true) => "에서 진행 중입니다",
            Some(false) => "에서 예정입니다",
            None => "에 있습니다",
        };
        format!("‘{epic}’는 ‘{title}’ 대화{state}. 여기서 할까요?")
    } else {
        let state = match running {
            Some(true) => "running in",
            Some(false) => "queued in",
            None => "in",
        };
        format!("‘{epic}’ is {state} ‘{title}’. Do it here?")
    }
}
