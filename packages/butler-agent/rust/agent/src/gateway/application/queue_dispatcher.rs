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
    AppApplication, AppStorageError, GatewayApplicationError, app_error, queue,
    send::ResolvedAppAdmission, settings,
};

const COMMAND_CAPACITY: usize = 64;
const FIFO_WINDOW: usize = 20;

#[derive(Clone)]
pub(super) struct QueueWake(mpsc::Sender<Command>);

impl QueueWake {
    pub(super) async fn chat(&self, chat_id: String) -> Result<(), GatewayApplicationError> {
        self.0
            .send(Command::Wake(Some(chat_id)))
            .await
            .map_err(|_| GatewayApplicationError::Internal)
    }

    pub(super) async fn drain_chat(&self, chat_id: String) -> Result<(), GatewayApplicationError> {
        let (reply, result) = oneshot::channel();
        self.0
            .send(Command::Drain { chat_id, reply })
            .await
            .map_err(|_| GatewayApplicationError::Internal)?;
        result
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
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
    Initialize(AppApplication),
    Wake(Option<String>),
    Drain {
        chat_id: String,
        reply: oneshot::Sender<Result<(), GatewayApplicationError>>,
    },
    Close,
}

impl QueueDispatcher {
    pub(super) fn start() -> (Self, QueueWake) {
        let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let cancellation = CancellationToken::new();
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
                cancellation,
            }),
        };
        (owner, QueueWake(sender))
    }

    pub(super) async fn initialize(
        &self,
        app: AppApplication,
    ) -> Result<(), GatewayApplicationError> {
        self.inner
            .sender
            .send(Command::Initialize(app))
            .await
            .map_err(|_| GatewayApplicationError::Internal)
    }

    pub(super) async fn wake_chat(&self, chat_id: String) -> Result<(), GatewayApplicationError> {
        self.inner
            .sender
            .send(Command::Wake(Some(chat_id)))
            .await
            .map_err(|_| GatewayApplicationError::Internal)
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
                        .map_err(|_| GatewayApplicationError::Internal)
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
                    let app = application.insert(app);
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
                    let result = tokio::select! {
                        () = cancellation.cancelled() => Err(GatewayApplicationError::Internal),
                        result = async {
                            match application.as_ref() {
                                Some(app) => recover_and_drain(&cancellation, app, Some(&chat_id)).await,
                                None => Err(GatewayApplicationError::Internal),
                            }
                        } => result,
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
    tokio::select! {
        () = cancellation.cancelled() => false,
        _ = recover_and_drain(cancellation, app, chat) => true,
    }
}

async fn recover_and_drain(
    cancellation: &CancellationToken,
    app: &AppApplication,
    only_chat: Option<&str>,
) -> Result<(), GatewayApplicationError> {
    if cancellation.is_cancelled() {
        return Err(GatewayApplicationError::Internal);
    }
    app.recover_expired().await?;
    let chats = if let Some(chat) = only_chat {
        vec![chat.to_owned()]
    } else {
        app.storage.execute(queued_chats).await.map_err(app_error)?
    };
    for chat in chats {
        drain_chat(app, &chat).await?;
    }
    Ok(())
}

async fn drain_chat(app: &AppApplication, chat_id: &str) -> Result<(), GatewayApplicationError> {
    let chat = chat_id.to_owned();
    let rows = app
        .storage
        .execute(move |db| queued_rows(db, &chat))
        .await
        .map_err(app_error)?;
    for row in rows {
        let chat = chat_id.to_owned();
        let active = app
            .storage
            .execute(move |db| session_has_active_turn(db, &chat))
            .await
            .map_err(app_error)?;
        if active {
            return Ok(());
        }
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
                    &now,
                    &subscribers,
                )
            })
            .await
            .map_err(app_error)?;
        let Some(claim) = claim else { continue };
        let resolution = match settings::resolution_from_persisted(&row.control_resolution_json) {
            Ok(resolution) => resolution,
            Err(_) => {
                let _ = app
                    .fail_dispatch(&claim, "turn_control_resolution_invalid")
                    .await;
                continue;
            }
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
            && !matches!(error, GatewayApplicationError::Public { ref code, .. } if code == "queued_message_claim_lost")
        {
            let _ = app
                .fail_dispatch(&claim, "queued_message_dispatch_failed")
                .await;
        }
    }
    Ok(())
}

struct QueuedRow {
    id: String,
    text: String,
    control_resolution_json: String,
}
fn queued_rows(db: &mut Connection, chat: &str) -> Result<Vec<QueuedRow>, AppStorageError> {
    let mut statement = db.prepare("SELECT id,text,control_resolution_json FROM session_queued_messages WHERE chat_id=?1 AND state='queued' ORDER BY rowid ASC LIMIT ?2")
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map(params![chat, FIFO_WINDOW], |row| {
            Ok(QueuedRow {
                id: row.get(0)?,
                text: row.get(1)?,
                control_resolution_json: row.get(2)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
fn queued_chats(db: &mut Connection) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db.prepare("SELECT chat_id FROM session_queued_messages WHERE state='queued' GROUP BY chat_id ORDER BY MIN(rowid)")
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
fn session_has_active_turn(db: &mut Connection, chat: &str) -> Result<bool, AppStorageError> {
    db.query_row("SELECT 1 FROM turns WHERE chat_id=?1 AND state IN ('accepted','thinking','streaming','waiting_for_form','waiting_for_tool','cancelling','retrying') LIMIT 1", [chat], |_| Ok(()))
        .optional().map(|row| row.is_some()).map_err(AppStorageError::sqlite)
}
async fn next_deadline(app: &AppApplication) -> Result<Option<Duration>, GatewayApplicationError> {
    let owner = app.queue_owner.clone();
    let now = app.dependencies.identity_clock.now_iso();
    app.storage.execute(move |db| {
        let value: Option<String> = db.query_row("SELECT MIN(lease_expires_at) FROM session_queued_messages WHERE state='dispatching' AND lease_expires_at IS NOT NULL AND lease_expires_at>?1 AND (claim_owner IS NULL OR claim_owner<>?2)", params![now, owner], |row| row.get(0)).map_err(AppStorageError::sqlite)?;
        let current = DateTime::parse_from_rfc3339(&now).ok();
        Ok(value.and_then(|value| {
            let millis = (DateTime::parse_from_rfc3339(&value).ok()? - current?)
                .num_milliseconds().max(0) as u64;
            Some(Duration::from_millis(millis))
        }))
    }).await.map_err(app_error)
}
fn lock<T>(value: &Mutex<T>) -> parking_lot::MutexGuard<'_, T> {
    value.lock()
}
