//! The storage owner commits an evidence receipt before native dispatch.
use super::{
    AppApplication, AppFileUpload, AppStorageError, GatewayApplicationError, app_error, read_model,
};
use crate::gateway::AppBrowserStillCommand as C;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

impl AppApplication {
    pub(super) async fn browser_still_owned(
        &self,
        command: C,
    ) -> Result<Value, GatewayApplicationError> {
        match command {
            C::Read { id, session } => self
                .storage
                .read(move |db| read(db, &id, &session))
                .await
                .map_err(app_error),
            C::Attach {
                id,
                session,
                tab,
                step,
                bytes,
            } => {
                let (key, owner, page) = (id.clone(), session.clone(), tab.clone());
                let pending = self.storage.read(move |db| {
                    db.query_row("SELECT COUNT(*) FROM browser_still_deliveries WHERE act_id=?1 AND session_id=?2 AND tab_id=?3 AND step=?4",
                        params![key, owner, page, step], |r| r.get::<_, usize>(0)).map_err(AppStorageError::sqlite)
                }).await.map_err(app_error)?;
                if pending != 1 {
                    return Err(super::public(
                        409,
                        "still_settled",
                        "Still already settled.",
                    ));
                }
                let lookup = id.clone();
                let previous = self.storage.read(move |db| {
                    db.query_row("SELECT file_id FROM browser_still_deliveries WHERE act_id=?1 AND step=?2", params![lookup, step], |row| row.get::<_, Option<String>>(0))
                        .map_err(AppStorageError::sqlite)
                }).await.map_err(app_error)?;
                if let Some(file) = previous {
                    return Ok(json!({"still_file": self.message_file_metadata(file).await?}));
                }
                let input = AppFileUpload {
                    browser_tab: Some(tab.clone()),
                    owner_session_id: Some(session),
                    name: "browser-step.jpg".into(),
                    mime_type: Some("image/jpeg".into()),
                    bytes,
                };
                let file = self
                    .upload_browser_still(input, tab, Some((id, step)))
                    .await?;
                Ok(json!({"still_file":file}))
            }
            command => self
                .storage
                .execute(move |db| mutate(db, command))
                .await
                .map_err(app_error),
        }
    }
}

fn mutate(db: &Connection, command: C) -> Result<Value, AppStorageError> {
    match command {
        C::Reserve {
            id,
            session,
            tab,
            count,
        } => {
            for step in 0..count.min(10) {
                db.execute("INSERT INTO browser_still_deliveries(act_id,step,session_id,tab_id) VALUES(?1,?2,?3,?4)",
                    params![id, step, session, tab]).map_err(AppStorageError::sqlite)?;
            }
        }
        C::Finish {
            id,
            session,
            awaiting,
            failures,
        } => {
            for step in 0..10 {
                if !awaiting.contains(&step) {
                    let reason = failures
                        .iter()
                        .find(|(index, _)| *index == step)
                        .map_or("pixels_not_captured", |(_, reason)| reason.as_str());
                    fail(db, &id, &session, step, reason)?;
                }
            }
        }
        C::Fail {
            id,
            session,
            step,
            reason,
        } => fail(db, &id, &session, step, &reason)?,
        C::SettlePending { reason } => {
            db.execute("UPDATE browser_still_deliveries SET state='failed',reason=?1 WHERE state='pending'", [reason])
                .map_err(AppStorageError::sqlite)?;
        }
        C::Read { .. } | C::Attach { .. } => {
            return Err(AppStorageError::new(
                super::storage::AppStorageCode::AppJsonFailed,
                "Invalid still write",
            ));
        }
    }
    Ok(json!({"ok":true}))
}

fn fail(
    db: &Connection,
    id: &str,
    session: &str,
    step: usize,
    reason: &str,
) -> Result<(), AppStorageError> {
    db.execute("UPDATE browser_still_deliveries SET state='failed',reason=?4 WHERE act_id=?1 AND session_id=?2 AND step=?3 AND state='pending'",
        params![id, session, step, reason]).map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn attached(
    db: &Connection,
    id: &str,
    step: usize,
    file: &str,
) -> Result<(), AppStorageError> {
    let changed = db.execute("UPDATE browser_still_deliveries SET state='attached',file_id=?3,reason=NULL WHERE act_id=?1 AND step=?2 AND state!='attached'",
        params![id, step, file]).map_err(AppStorageError::sqlite)?;
    if changed != 1 {
        return Err(AppStorageError::new(
            super::storage::AppStorageCode::MessageFileNotFound,
            "Still reservation missing",
        ));
    }
    Ok(())
}

fn read(db: &Connection, id: &str, session: &str) -> Result<Value, AppStorageError> {
    let mut query = db.prepare("SELECT step,tab_id,state,file_id,reason FROM browser_still_deliveries WHERE act_id=?1 AND session_id=?2 ORDER BY step LIMIT 10")
        .map_err(AppStorageError::sqlite)?;
    let rows = query
        .query_map(params![id, session], |r| {
            Ok((
                r.get::<_, usize>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let mut steps = Vec::new();
    for (step, tab, state, file, reason) in rows {
        let mut row = json!({"step":step,"tab":tab,"state":state,"reason":reason});
        if let Some(file) = file
            .map(|id| super::admission::file(db, &id))
            .transpose()?
            .flatten()
        {
            row["still_file"] = json!(read_model::message_file_ref(&file)?);
        }
        steps.push(row);
    }
    let complete = steps.iter().all(|row| row["state"] != "pending");
    Ok(json!({"act_id":id,"complete":complete,"steps":steps}))
}
