//! Transactional enqueue, delivery and panel-state events.
use super::{
    super::{AppApplication, AppStorageError, GatewayApplicationError, app_error, events},
    gate::Hold,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

#[derive(Clone)]
pub(super) struct Entry {
    pub(super) id: String,
    pub(super) chat: String,
    pub(super) kind: String,
    next_attempt_at: Option<String>,
    /// S5 connector items under an explicit user rule may bypass quiet hours.
    /// All S2 producers leave this false.
    pub(super) bypass_quiet_hours: bool,
}

impl Entry {
    fn hold(&self, gate: &super::gate::Gate, db: &Connection) -> Result<Hold, AppStorageError> {
        if self.kind == "work_result" {
            gate.work_hold(&self.chat, self.bypass_quiet_hours)
        } else {
            gate.hold(db, &self.chat, self.bypass_quiet_hours)
        }
    }
}

pub(super) fn enqueue(
    db: &Connection,
    identity: (&str, &str),
    source: &str,
    kind: &str,
    text: &str,
    payload: &Value,
    now: &str,
) -> Result<(), AppStorageError> {
    let (id, chat) = identity;
    db.execute("INSERT OR IGNORE INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,state,created_at) VALUES(?1,?7,?2,?3,?4,?5,'held',?6)",
        params![id,kind,source,text,payload.to_string(),now,chat]).map_err(AppStorageError::sqlite)?;
    Ok(())
}

fn held(db: &Connection) -> Result<Vec<Entry>, AppStorageError> {
    let mut statement = db.prepare_cached("SELECT id,chat_id,bypass_quiet_hours,kind,next_attempt_at FROM app_initiated_messages WHERE state='held' AND posting=0 AND (reason IS NULL OR reason<>'session_model_unavailable') ORDER BY created_at,rowid").map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], |r| {
            Ok(Entry {
                id: r.get(0)?,
                chat: r.get(1)?,
                kind: r.get(3)?,
                next_attempt_at: r.get(4)?,
                bypass_quiet_hours: r.get(2)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

impl AppApplication {
    pub(in crate::gateway::application) async fn deliver_initiated(
        &self,
    ) -> Result<(), GatewayApplicationError> {
        let rows = self.storage.read(held).await.map_err(app_error)?;
        if rows.is_empty() {
            return Ok(());
        }
        for entry in rows {
            if let Err(error) = self.deliver_entry(&entry).await {
                self.initiated_failure(entry.id.clone(), &error).await?;
            }
        }
        Ok(())
    }

    async fn deliver_entry(&self, entry: &Entry) -> Result<(), GatewayApplicationError> {
        let gate = self.initiated_gate().await?;
        if entry
            .next_attempt_at
            .as_ref()
            .is_some_and(|at| at > &gate.now)
        {
            return Ok(());
        }
        let row = entry.clone();
        let free = self
            .storage
            .read(move |db| Ok(matches!(row.hold(&gate, db)?, Hold::Free)))
            .await
            .map_err(app_error)?;
        if !free {
            return Ok(());
        }
        if entry.kind == "work_result" {
            self.deliver_work_result(entry.id.clone()).await?;
            return Ok(());
        }
        let gate = self.initiated_gate().await?;
        let subscribers = self.subscribers.clone();
        let entry = entry.clone();
        self.storage
            .execute(move |db| {
                if matches!(entry.hold(&gate, db)?, Hold::Free) {
                    post(db, &subscribers, &entry, &gate.now, gate.quiet()?)?;
                }
                Ok(())
            })
            .await
            .map_err(app_error)
    }

    pub(in crate::gateway::application) async fn next_initiated_due(
        &self,
    ) -> Result<Option<String>, GatewayApplicationError> {
        let mut rows = self.storage.read(held).await.map_err(app_error)?;
        let queued = self.storage.read(|db| db.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_automation_runs WHERE state='queued' AND trigger='scheduled' AND target_session_id='general')",
            [], |r| r.get::<_,bool>(0)).map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
        if queued {
            rows.push(Entry {
                id: String::new(),
                kind: String::new(),
                next_attempt_at: None,
                chat: "general".into(),
                bypass_quiet_hours: false,
            });
        }
        if rows.is_empty() {
            return Ok(None);
        }
        let gate = self.initiated_gate().await?;
        self.storage
            .read(move |db| {
                let mut next = None;
                for entry in rows {
                    let hold = entry.hold(&gate, db)?;
                    let until = if matches!(hold, Hold::Free) {
                        Some(gate.now.clone())
                    } else {
                        hold.until()
                    };
                    if let Some(at) = until {
                        let at = entry
                            .next_attempt_at
                            .map_or(at.clone(), |retry| retry.max(at));
                        next = Some(next.map_or(at.clone(), |old: String| old.min(at)));
                    }
                }
                Ok(next)
            })
            .await
            .map_err(app_error)
    }
}

fn post(
    db: &mut Connection,
    subscribers: &events::EventSubscribers,
    entry: &Entry,
    now: &str,
    quiet: bool,
) -> Result<(), AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let message_id = format!("initiated-{}", entry.id);
    let inserted = tx.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,retryable) SELECT ?1,chat_id,'assistant',text,'delivered',?2,?2,0 FROM app_initiated_messages WHERE id=?3 AND state='held'", params![message_id,now,entry.id]).map_err(AppStorageError::sqlite)?;
    // Another dispatcher may have posted the row after the held-entry read.
    if inserted == 0 {
        return Ok(());
    }
    tx.execute("UPDATE app_initiated_messages SET state='posted',message_id=?1,posted_at=?2,quiet=?3 WHERE id=?4", params![message_id,now,quiet,entry.id]).map_err(AppStorageError::sqlite)?;
    tx.execute(
        "UPDATE chats SET updated_at=?1 WHERE id=?2",
        params![now, entry.chat],
    )
    .map_err(AppStorageError::sqlite)?;
    let event = message_event(&tx, "message.created", &message_id, now)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, &event);
    Ok(())
}

pub(super) fn update_payload(
    db: &Connection,
    source: &str,
    payload: &Value,
    now: &str,
) -> Result<Option<crate::gateway::AppEventEnvelope>, AppStorageError> {
    db.execute(
        "UPDATE app_initiated_messages SET payload_json=?1 WHERE source_key=?2",
        params![payload.to_string(), source],
    )
    .map_err(AppStorageError::sqlite)?;
    let id: Option<String> = db
        .query_row(
            "SELECT message_id FROM app_initiated_messages WHERE source_key=?1",
            [source],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .flatten();
    id.map(|id| {
        db.execute(
            "UPDATE messages SET updated_at=?1 WHERE id=?2",
            params![now, id],
        )
        .map_err(AppStorageError::sqlite)?;
        message_event(db, "message.updated", &id, now)
    })
    .transpose()
}

fn message_event(
    db: &Connection,
    kind: &str,
    id: &str,
    now: &str,
) -> Result<crate::gateway::AppEventEnvelope, AppStorageError> {
    let row = super::super::read_model::exact_message(
        db,
        &db.query_row("SELECT chat_id FROM messages WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(AppStorageError::sqlite)?,
        id,
    )?
    .ok_or_else(|| {
        AppStorageError::new(
            super::super::storage::AppStorageCode::ProjectedMessageMissing,
            "Projected message missing.",
        )
    })?;
    events::append_unpublished(
        db,
        kind,
        None,
        super::super::service::map(&json!({"message":row}))?,
        now,
    )
}

pub(super) fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new(
        super::super::storage::AppStorageCode::AutomationJsonFailed,
        error.to_string(),
    )
    .with_source(error)
}
