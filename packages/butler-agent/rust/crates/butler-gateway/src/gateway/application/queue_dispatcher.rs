//! Long-lived FIFO session queue dispatch and lease recovery ownership.

use parking_lot::Mutex;
use std::{sync::Arc, time::Duration};

use chrono::DateTime;
use rusqlite::{Connection, OptionalExtension, params};
use tokio::{
    sync::{Notify, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use super::{
    AppApplication, AppStorageError, CachedSql, GatewayApplicationError, app_error, queue,
    send::ResolvedAppAdmission, settings,
};

const COMMAND_CAPACITY: usize = 64;
const FIFO_WINDOW: usize = 20;

#[derive(Clone)]
pub(super) struct QueueWake {
    sender: mpsc::Sender<Command>,
    cancellation: CancellationToken,
}

impl QueueWake {
    #[cfg(debug_assertions)]
    pub(super) async fn stopped(&self) {
        self.cancellation.cancelled().await;
    }

    pub(super) fn is_stopping(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub(super) async fn chat(&self, chat_id: String) -> Result<(), GatewayApplicationError> {
        // Terminal projection still settles claims after queue admission stops.
        // Persisted waiting input will be dispatched by the next process.
        if self.cancellation.is_cancelled() {
            return Ok(());
        }
        match self.sender.send(Command::Wake(Some(chat_id))).await {
            Ok(()) => Ok(()),
            Err(_) if self.cancellation.is_cancelled() => Ok(()),
            Err(error) => Err(GatewayApplicationError::internal_from(error)),
        }
    }

    pub(super) async fn drain_chat(&self, chat_id: String) -> Result<(), GatewayApplicationError> {
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Command::Drain { chat_id, reply })
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        result
            .await
            .map_err(GatewayApplicationError::internal_from)?
    }
}

#[derive(Clone)]
pub(super) struct QueueDispatcher {
    inner: Arc<Inner>,
}
struct Inner {
    sender: mpsc::Sender<Command>,
    task: Mutex<Option<JoinHandle<Result<(), GatewayApplicationError>>>>,
    close: Mutex<CloseState>,
    closed: Notify,
    cancellation: CancellationToken,
}
struct CloseState {
    started: bool,
    result: Option<Result<(), GatewayApplicationError>>,
}
enum Command {
    Initialize(Box<AppApplication>),
    Wake(Option<String>),
    Drain {
        chat_id: String,
        reply: oneshot::Sender<Result<(), GatewayApplicationError>>,
    },
    Close,
}

impl QueueDispatcher {
    pub(super) fn start(cancellation: CancellationToken) -> (Self, QueueWake) {
        let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let task = tokio::spawn(run(receiver, cancellation.clone()));
        let owner = Self {
            inner: Arc::new(Inner {
                sender: sender.clone(),
                task: Mutex::new(Some(task)),
                close: Mutex::new(CloseState {
                    started: false,
                    result: None,
                }),
                closed: Notify::new(),
                cancellation: cancellation.clone(),
            }),
        };
        (
            owner,
            QueueWake {
                sender,
                cancellation,
            },
        )
    }

    pub(super) async fn initialize(
        &self,
        app: AppApplication,
    ) -> Result<(), GatewayApplicationError> {
        self.inner
            .sender
            .send(Command::Initialize(Box::new(app)))
            .await
            .map_err(GatewayApplicationError::internal_from)
    }

    pub(super) async fn wake_chat(&self, chat_id: String) -> Result<(), GatewayApplicationError> {
        self.inner
            .sender
            .send(Command::Wake(Some(chat_id)))
            .await
            .map_err(GatewayApplicationError::internal_from)
    }

    pub(super) async fn close(&self) -> Result<(), GatewayApplicationError> {
        let start = {
            let mut state = lock(&self.inner.close);
            if let Some(result) = &state.result {
                return result.clone();
            }
            if state.started {
                false
            } else {
                state.started = true;
                true
            }
        };
        if start {
            self.inner.cancellation.cancel();
            if let Some(task) = lock(&self.inner.task).take() {
                let inner = Arc::clone(&self.inner);
                // Completion remains owned if the first close caller is dropped.
                tokio::spawn(async move {
                    let _ = inner.sender.send(Command::Close).await;
                    let result = task
                        .await
                        .map_err(GatewayApplicationError::internal_from)
                        .and_then(|value| value);
                    lock(&inner.close).result = Some(result);
                    inner.closed.notify_waiters();
                });
            }
        }
        loop {
            // Register before inspecting the result so completion cannot be lost.
            let completed = self.inner.closed.notified();
            tokio::pin!(completed);
            completed.as_mut().enable();
            if let Some(result) = lock(&self.inner.close).result.clone() {
                return result;
            }
            completed.await;
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.sender.try_send(Command::Close);
    }
}

async fn run(
    mut receiver: mpsc::Receiver<Command>,
    cancellation: CancellationToken,
) -> Result<(), GatewayApplicationError> {
    let mut application: Option<AppApplication> = None;
    let mut deadline: Option<Duration> = None;
    loop {
        let delay = deadline.map(tokio::time::sleep);
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            command = receiver.recv() => match command {
                Some(Command::Initialize(app)) => {
                    let app = application.insert(*app);
                    if !cycle(&cancellation, app, None).await { return Ok(()); }
                    deadline = next_deadline(app).await.ok().flatten();
                }
                Some(Command::Wake(chat)) => {
                    if let Some(app) = application.as_ref() {
                        if !cycle(&cancellation, app, chat.as_deref()).await { return Ok(()); }
                        deadline = next_deadline(app).await.ok().flatten();
                    }
                }
                Some(Command::Drain { chat_id, reply }) => {
                    let result = match application.as_ref() {
                        Some(app) => recover_and_drain(&cancellation, app, Some(&chat_id)).await,
                        None => Err(GatewayApplicationError::internal()),
                    };
                    if let Some(app) = application.as_ref() {
                        deadline = next_deadline(app).await.ok().flatten();
                    }
                    let _ = reply.send(result);
                }
                Some(Command::Close) | None => return Ok(()),
            },
            () = async { if let Some(delay) = delay { delay.await } }, if deadline.is_some() => {
                if let Some(app) = application.as_ref() {
                    if !cycle(&cancellation, app, None).await { return Ok(()); }
                    deadline = next_deadline(app).await.ok().flatten();
                }
            }
        }
    }
}

async fn cycle(cancellation: &CancellationToken, app: &AppApplication, chat: Option<&str>) -> bool {
    // An admission owns a durable App claim before native enqueue. Dropping it
    // on close can leave a thinking turn with no native record to recover.
    let _ = recover_and_drain(cancellation, app, chat).await;
    !cancellation.is_cancelled()
}

async fn recover_and_drain(
    cancellation: &CancellationToken,
    app: &AppApplication,
    only_chat: Option<&str>,
) -> Result<(), GatewayApplicationError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => return Ok(()),
        ready = app.dependencies.executor_readiness.wait_ready() => ready?,
    }
    app.recover_expired().await?;
    let chats = if let Some(chat) = only_chat {
        vec![chat.to_owned()]
    } else {
        app.storage.execute(queued_chats).await.map_err(app_error)?
    };
    for chat in chats {
        drain_chat(cancellation, app, &chat).await?;
    }
    Ok(())
}

async fn drain_chat(
    cancellation: &CancellationToken,
    app: &AppApplication,
    chat_id: &str,
) -> Result<(), GatewayApplicationError> {
    let chat = chat_id.to_owned();
    let rows = app
        .storage
        .execute(move |db| queued_rows(db, &chat))
        .await
        .map_err(app_error)?;
    for row in rows {
        if cancellation.is_cancelled() {
            return Ok(());
        }
        let Some(order) = dispatch_order(app, chat_id, &row).await? else {
            continue;
        };
        let now = app.dependencies.identity_clock.now_iso();
        let lease = app
            .dependencies
            .identity_clock
            .iso_after_millis(queue::SESSION_QUEUE_LEASE_MILLIS as u64);
        let claim_id = app.dependencies.identity_clock.new_uuid();
        let owner = app.queue_owner.clone();
        let subscribers = app.subscribers.clone();
        let chat = chat_id.to_owned();
        let queued = row.id.clone();
        let claim = app
            .storage
            .execute(move |db| {
                queue::claim(
                    db,
                    &queue::QueueClaim {
                        queued_message_id: queued,
                        chat_id: chat,
                        claim_id,
                        claim_owner: owner,
                        lease_expires_at: lease,
                    },
                    order,
                    &now,
                    &subscribers,
                )
            })
            .await
            .map_err(app_error)?;
        let Some(claim) = claim else { continue };
        let Ok(resolution) = settings::resolution_from_persisted(&row.control_resolution_json)
        else {
            let _ = app
                .fail_dispatch(&claim, "turn_control_resolution_invalid")
                .await;
            continue;
        };
        if let Err(error) = app
            .start_turn(
                claim.clone(),
                ResolvedAppAdmission {
                    text: row.text,
                    controls: resolution,
                },
            )
            .await
            && !matches!(error, GatewayApplicationError::Public { ref code, .. } if code == "queued_message_claim_lost" || code == "service_stopping")
        {
            let _ = app
                .fail_dispatch(&claim, "queued_message_dispatch_failed")
                .await;
        }
    }
    Ok(())
}

async fn dispatch_order(
    app: &AppApplication,
    chat: &str,
    row: &QueuedRow,
) -> Result<Option<queue::ClaimOrder>, GatewayApplicationError> {
    let order = app.admit_instruction(chat, &row.client_message_id).await?;
    if matches!(order, Some(queue::ClaimOrder::Immediate)) {
        return Ok(order);
    }
    let chat = chat.to_owned();
    let active = app
        .storage
        .execute(move |db| session_has_active_turn(db, &chat))
        .await
        .map_err(app_error)?;
    Ok(if active { None } else { order })
}

struct QueuedRow {
    client_message_id: String,
    id: String,
    text: String,
    control_resolution_json: String,
}
fn queued_rows(db: &mut Connection, chat: &str) -> Result<Vec<QueuedRow>, AppStorageError> {
    let mut statement = db.prepare_cached("SELECT id,text,control_resolution_json,client_message_id FROM (SELECT rowid AS position,id,text,control_resolution_json,client_message_id FROM (SELECT rowid,id,text,control_resolution_json,client_message_id FROM session_queued_messages WHERE chat_id=?1 AND state='queued' ORDER BY rowid LIMIT ?2) UNION SELECT rowid AS position,id,text,control_resolution_json,client_message_id FROM (SELECT rowid,id,text,control_resolution_json,client_message_id FROM session_queued_messages WHERE chat_id=?1 AND state='queued' AND json_valid(control_resolution_json) AND json_extract(control_resolution_json,'$.instruction_mode')='steer' ORDER BY rowid LIMIT ?2)) WHERE NOT EXISTS (SELECT 1 FROM session_queue_pauses p WHERE p.chat_id=?1) ORDER BY position")
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map(params![chat, FIFO_WINDOW], |row| {
            Ok(QueuedRow {
                id: row.get(0)?,
                text: row.get(1)?,
                control_resolution_json: row.get(2)?,
                client_message_id: row.get(3)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
/// The `state IN` term repeats the predicate of the partial
/// `session_queued_messages_active_idx`, which makes it applicable.
pub(super) const QUEUED_CHATS_SQL: &str = "SELECT chat_id FROM session_queued_messages q \
    WHERE state='queued' AND state IN ('queued','dispatching') AND NOT EXISTS \
    (SELECT 1 FROM session_queue_pauses p WHERE p.chat_id=q.chat_id) \
    GROUP BY chat_id ORDER BY MIN(rowid)";
/// Same index term as `QUEUED_CHATS_SQL`.
pub(super) const LEASE_DEADLINE_SQL: &str = "SELECT MIN(lease_expires_at) \
    FROM session_queued_messages WHERE state='dispatching' AND state IN ('queued','dispatching') \
    AND lease_expires_at IS NOT NULL AND lease_expires_at>?1 \
    AND (claim_owner IS NULL OR claim_owner<>?2)";

fn queued_chats(db: &mut Connection) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db
        .prepare_cached(QUEUED_CHATS_SQL)
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
fn session_has_active_turn(db: &mut Connection, chat: &str) -> Result<bool, AppStorageError> {
    db.query_row_cached("SELECT 1 FROM turns t WHERE chat_id=?1 AND NOT EXISTS (SELECT 1 FROM session_queued_messages q WHERE q.chat_id=t.chat_id AND q.turn_id=t.id AND q.state='queued' AND q.state IN ('queued','dispatching')) AND state IN ('accepted','thinking','streaming','waiting_for_form','waiting_for_tool','cancelling','retrying') LIMIT 1", [chat], |_| Ok(()))
        .optional().map(|row| row.is_some()).map_err(AppStorageError::sqlite)
}
async fn next_deadline(app: &AppApplication) -> Result<Option<Duration>, GatewayApplicationError> {
    let owner = app.queue_owner.clone();
    let now = app.dependencies.identity_clock.now_iso();
    app.storage
        .execute(move |db| {
            let value: Option<String> = db
                .query_row_cached(LEASE_DEADLINE_SQL, params![now, owner], |row| row.get(0))
                .map_err(AppStorageError::sqlite)?;
            let current = DateTime::parse_from_rfc3339(&now).ok();
            Ok(value.and_then(|value| {
                let millis = u64::try_from(
                    (DateTime::parse_from_rfc3339(&value).ok()? - current?)
                        .num_milliseconds()
                        .max(0),
                )
                .unwrap_or_default();
                Some(Duration::from_millis(millis))
            }))
        })
        .await
        .map_err(app_error)
}
fn lock<T>(value: &Mutex<T>) -> parking_lot::MutexGuard<'_, T> {
    value.lock()
}
