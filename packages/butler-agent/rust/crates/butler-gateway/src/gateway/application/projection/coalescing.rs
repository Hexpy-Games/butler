//! Per-session, loss-bounded transport deltas; SQL transactions remain short.
use super::{
    ProjectionContext, TranscriptEvent,
    checkpoint::{self, Checkpoint},
    non_final, staging,
};
use crate::gateway::application::{GatewayApplicationError, app_error};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_millis(100);
#[derive(Default)]
pub(super) struct Buffer(Mutex<HashMap<String, Session>>);
#[derive(Clone)]
struct Session {
    opened: Instant,
    cursor: Checkpoint,
    staged: HashMap<String, TranscriptEvent>,
    deltas: Vec<Delta>,
}
#[derive(Clone)]
struct Delta {
    action: String,
    outbound: TranscriptEvent,
    cursor: Checkpoint,
    event_id: String,
    message_id: String,
    now: String,
}
impl Buffer {
    pub(super) fn until_flush(&self) -> Option<Duration> {
        self.0
            .lock()
            .values()
            .map(|session| WINDOW.saturating_sub(session.opened.elapsed()))
            .min()
    }
    pub(super) fn checkpoint(&self, chat: &str) -> Option<Checkpoint> {
        self.0
            .lock()
            .get(chat)
            .map(|session| session.cursor.clone())
    }
    pub(super) fn advance(&self, cursor: &Checkpoint) -> bool {
        if let Some(session) = self.0.lock().get_mut(&cursor.chat_id) {
            session.cursor = cursor.clone();
            true
        } else {
            false
        }
    }
    fn stage(
        &self,
        chat: &str,
        action: String,
        event: TranscriptEvent,
        cursor: Checkpoint,
    ) -> Result<(), GatewayApplicationError> {
        let mut sessions = self.0.lock();
        let session = sessions.entry(chat.to_owned()).or_insert_with(|| Session {
            opened: Instant::now(),
            cursor: cursor.clone(),
            staged: HashMap::new(),
            deltas: Vec::new(),
        });
        if let Some(prior) = session.staged.get(&action) {
            let claim = staging::claim_id_from_event(prior);
            let replaces = claim.is_some() && claim != staging::claim_id_from_event(&event);
            if !replaces && !staging::same_action(prior, &event) {
                return Err(app_error(super::super::storage::AppStorageError::new(
                    super::super::storage::AppStorageCode::AppStagedOutboundIdentityConflict,
                    "Transport staged outbound identity conflict",
                )));
            }
        }
        session.cursor = cursor;
        session.staged.insert(action, event);
        Ok(())
    }
    fn delivered(
        &self,
        context: &ProjectionContext,
        chat: &str,
        action: String,
        event: TranscriptEvent,
        cursor: Checkpoint,
    ) {
        let mut sessions = self.0.lock();
        let session = sessions.entry(chat.to_owned()).or_insert_with(|| Session {
            opened: Instant::now(),
            cursor: cursor.clone(),
            staged: HashMap::new(),
            deltas: Vec::new(),
        });
        session.staged.remove(&action);
        session.cursor = cursor.clone();
        session.deltas.push(Delta {
            action,
            outbound: event,
            cursor,
            event_id: format!(
                "turn-event-{}",
                context.dependencies.identity_clock.new_uuid()
            ),
            message_id: format!("message-{}", context.dependencies.identity_clock.new_uuid()),
            now: context.dependencies.identity_clock.now_iso(),
        });
    }
    pub(super) async fn handle(
        &self,
        context: &ProjectionContext,
        chat: &str,
        event: &TranscriptEvent,
        cursor: &Checkpoint,
    ) -> Result<bool, GatewayApplicationError> {
        if super::super::storage::metrics::baseline() || event.transport.as_deref() != Some("app") {
            return Ok(false);
        }
        let Some(action) = super::delivery::action_id(event) else {
            return Ok(false);
        };
        if event.kind == "outbound" && super::stream_window::stream_delta(event) {
            self.stage(chat, action, event.clone(), cursor.clone())?;
            return Ok(true);
        }
        if event.kind != "delivery"
            || event.payload.get("ok") != Some(&serde_json::Value::Bool(true))
        {
            return Ok(false);
        }
        let memory = self
            .0
            .lock()
            .get(chat)
            .and_then(|session| session.staged.get(&action).cloned());
        let outbound = match memory {
            Some(event) => Some(event),
            None => {
                let lookup = action.clone();
                context
                    .storage
                    .inspect(move |db| staging::load_awaiting(db, &lookup))
                    .await
                    .map_err(app_error)?
                    .filter(|(stored_chat, _)| stored_chat == chat)
                    .map(|(_, event)| event)
            }
        };
        let Some(outbound) = outbound.filter(super::stream_window::stream_delta) else {
            return Ok(false);
        };
        self.delivered(context, chat, action, outbound, cursor.clone());
        Ok(true)
    }
    pub(super) async fn flush_due(
        &self,
        context: &ProjectionContext,
    ) -> Result<(), GatewayApplicationError> {
        let chats = self
            .0
            .lock()
            .iter()
            .filter(|(_, session)| session.opened.elapsed() >= WINDOW)
            .map(|(chat, _)| chat.clone())
            .collect::<Vec<_>>();
        self.flush_chats(context, chats).await
    }
    pub(super) async fn flush_all(
        &self,
        context: &ProjectionContext,
    ) -> Result<(), GatewayApplicationError> {
        let chats = self.0.lock().keys().cloned().collect::<Vec<_>>();
        self.flush_chats(context, chats).await
    }
    async fn flush_chats(
        &self,
        context: &ProjectionContext,
        chats: Vec<String>,
    ) -> Result<(), GatewayApplicationError> {
        // Await every flush, even after an error, so failed sessions are restored
        // and successful sessions cannot lose an admitted operation's completion.
        let results =
            futures_util::future::join_all(chats.iter().map(|chat| self.flush(context, chat)))
                .await;
        for result in results {
            result?;
        }
        Ok(())
    }
    pub(super) async fn flush(
        &self,
        context: &ProjectionContext,
        chat: &str,
    ) -> Result<(), GatewayApplicationError> {
        let Some(session) = self.0.lock().remove(chat) else {
            return Ok(());
        };
        let pending = Arc::new(session);
        let result = flush_session(context, chat, pending.clone()).await;
        if result.is_err() {
            self.0.lock().insert(chat.to_owned(), (*pending).clone());
        }
        result
    }
}
fn persist(
    db: &mut rusqlite::Connection,
    chat: &str,
    delta: &Delta,
    subscribers: &super::super::EventSubscribers,
) -> Result<(), super::super::storage::AppStorageError> {
    // A confirmed in-memory pair needs no SQL staging round trip. Its source
    // records remain durable; apply atomically writes its receipt and cursor.
    // Validate any staging retained by an earlier flush/restart as usual.
    if staging::load(db, &delta.action)?.is_some() {
        stage(db, &delta.action, chat, &delta.outbound, &delta.now)?;
    }
    let outcome = non_final::apply(
        db,
        non_final::ApplyInput {
            chat_id: chat,
            action_id: &delta.action,
            outbound: &delta.outbound,
            cursor: &delta.cursor,
            now: &delta.now,
            subscribers,
            ids: non_final::ProjectionIds {
                event_id: delta.event_id.clone(),
                message_id: delta.message_id.clone(),
            },
            worker_files: Vec::new(),
        },
    )?;
    if !outcome.handled {
        return Err(super::super::storage::AppStorageError::new(
            super::super::storage::AppStorageCode::AppProjectionMissing,
            "Streaming delta was not projected.",
        ));
    }
    Ok(())
}

fn stage(
    db: &rusqlite::Connection,
    action: &str,
    chat: &str,
    outbound: &TranscriptEvent,
    now: &str,
) -> Result<(), super::super::storage::AppStorageError> {
    if staging::projected(db, action)? {
        return Ok(());
    }
    let claim = staging::claim_id_from_event(outbound);
    staging::stage(db, action, chat, outbound, claim.as_deref(), now)
}

// Bound each operation's SQL work so one busy session cannot monopolize the
// lane. All chunks belong to one 100ms flush; receipts make a partially
// committed flush replayable from the previous cursor after a crash.
async fn flush_session(
    context: &ProjectionContext,
    chat: &str,
    session: Arc<Session>,
) -> Result<(), GatewayApplicationError> {
    for offset in (0..session.deltas.len().max(1)).step_by(8) {
        let end = (offset + 8).min(session.deltas.len());
        let deltas = session.deltas[offset..end].to_vec();
        let last = end == session.deltas.len();
        let pending = session.clone();
        let chat_id = chat.to_owned();
        let subscribers = context.subscribers.clone();
        let now = context.dependencies.identity_clock.now_iso();
        context
            .storage
            .execute(move |db| {
                non_final::batch::run(|| {
                    for delta in &deltas {
                        persist(db, &chat_id, delta, &subscribers)?;
                    }
                    Ok::<_, super::super::storage::AppStorageError>(())
                })?;
                if last {
                    for (action, outbound) in &pending.staged {
                        stage(db, action, &chat_id, outbound, &now)?;
                    }
                    checkpoint::save(db, &pending.cursor, &now)?;
                }
                Ok(())
            })
            .await
            .map_err(app_error)?;
    }
    Ok(())
}
