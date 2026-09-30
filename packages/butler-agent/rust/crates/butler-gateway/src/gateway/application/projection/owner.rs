//! Native watcher and bounded projection worker ownership.

use parking_lot::Mutex;
use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::OptionalExtension;
use tokio::{
    sync::{Notify, mpsc, oneshot},
    task::JoinHandle,
};

mod files;
mod notifications;
use notifications::Pending;

use super::{ProjectionContext, sync_chat_once, sync_deferred_once, sync_deferred_step};
use crate::gateway::GatewayApplicationError;
use files::{open_turn_transcripts, resolve_chat_file};

const NOTIFICATION_CAPACITY: usize = 64;
const SETTLE_DELAY: Duration = Duration::from_millis(25);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(in crate::gateway::application) struct ProjectionOwner {
    inner: Arc<Inner>,
}
struct Inner {
    sender: mpsc::Sender<Command>,
    #[cfg(test)]
    pending: Arc<Mutex<Pending>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    task: Mutex<Option<JoinHandle<Result<(), GatewayApplicationError>>>>,
    close: Mutex<CloseState>,
    closed: Notify,
}
struct CloseState {
    started: bool,
    result: Option<Result<(), GatewayApplicationError>>,
}
enum Command {
    Wake,
    Events,
    Terminal,
    Refresh(String, oneshot::Sender<Result<(), GatewayApplicationError>>),
    Drain(oneshot::Sender<Result<(), GatewayApplicationError>>),
    Close,
    #[cfg(test)]
    Pause(oneshot::Sender<()>, oneshot::Receiver<()>),
}

impl ProjectionOwner {
    pub(in crate::gateway::application) fn start(
        context: ProjectionContext,
    ) -> Result<Self, GatewayApplicationError> {
        // Watch and match canonical roots: FSEvents reports resolved paths, so
        // a DATA root under a symlink (e.g. /var -> /private/var) would
        // otherwise never match and every change would be dropped.
        let watched_root = |relative: &str| {
            let path = context.butler_data.join(relative);
            std::fs::create_dir_all(&path)
                .and_then(|()| butler_platform::secure_fs::canonicalize(&path))
                .map_err(GatewayApplicationError::internal_from)
        };
        let transcript_root = watched_root("transcripts")?;
        let processed_root = watched_root("runtime/inbound-events/processed")?;
        let failed_root = watched_root("runtime/inbound-events/failed")?;
        let roots = [
            transcript_root.clone(),
            processed_root.clone(),
            failed_root.clone(),
        ];
        let (sender, receiver) = mpsc::channel(NOTIFICATION_CAPACITY);
        let pending = Arc::new(Mutex::new(Pending::default()));
        let observed = pending.clone();
        let callback = sender.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    for path in event.paths {
                        if path.parent() == Some(transcript_root.as_path()) {
                            if path.extension().is_some_and(|value| value == "jsonl")
                                && let Some(file) = path.file_name().and_then(|v| v.to_str())
                            {
                                notifications::transcript(&observed, &callback, file.to_owned());
                            }
                        } else if path.extension().is_none_or(|value| value != "tmp")
                            && (path == processed_root
                                || path == failed_root
                                || path.parent() == Some(processed_root.as_path())
                                || path.parent() == Some(failed_root.as_path()))
                        {
                            observed.lock().terminal = true;
                            let _ = callback.try_send(Command::Events);
                        }
                    }
                }
            })
            .map_err(GatewayApplicationError::internal_from)?;
        for path in &roots {
            watcher
                .watch(path, RecursiveMode::NonRecursive)
                .map_err(GatewayApplicationError::internal_from)?;
        }
        let task = tokio::spawn(run(context, receiver, pending.clone()));
        let owner = Self {
            inner: Arc::new(Inner {
                sender,
                #[cfg(test)]
                pending,
                watcher: Mutex::new(Some(watcher)),
                task: Mutex::new(Some(task)),
                close: Mutex::new(CloseState {
                    started: false,
                    result: None,
                }),
                closed: Notify::new(),
            }),
        };
        let _ = owner.inner.sender.try_send(Command::Wake);
        Ok(owner)
    }

    #[cfg(test)]
    pub(in crate::gateway::application) async fn pause_for_burst(&self) -> oneshot::Sender<()> {
        lock(&self.inner.watcher).take();
        let (entered, ready) = oneshot::channel();
        let (release, resumed) = oneshot::channel();
        self.inner
            .sender
            .send(Command::Pause(entered, resumed))
            .await
            .unwrap();
        ready.await.unwrap();
        release
    }

    #[cfg(test)]
    pub(in crate::gateway::application) fn transcript_event(&self, file: String) {
        notifications::transcript(&self.inner.pending, &self.inner.sender, file);
    }

    pub(in crate::gateway::application) async fn refresh(
        &self,
        chat_id: String,
    ) -> Result<(), GatewayApplicationError> {
        let (sender, receiver) = oneshot::channel();
        self.inner
            .sender
            .send(Command::Refresh(chat_id, sender))
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        receiver
            .await
            .map_err(GatewayApplicationError::internal_from)?
    }

    /// Finish terminal records before queue recovery can replace their claims.
    pub(in crate::gateway::application) async fn drain(
        &self,
    ) -> Result<(), GatewayApplicationError> {
        let (sender, receiver) = oneshot::channel();
        self.inner
            .sender
            .send(Command::Drain(sender))
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        receiver
            .await
            .map_err(GatewayApplicationError::internal_from)?
    }

    pub(in crate::gateway::application) async fn close(
        &self,
    ) -> Result<(), GatewayApplicationError> {
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
            lock(&self.inner.watcher).take();
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
        self.watcher.get_mut().take();
        let _ = self.sender.try_send(Command::Close);
    }
}

async fn run(
    context: ProjectionContext,
    mut receiver: mpsc::Receiver<Command>,
    pending: Arc<Mutex<Pending>>,
) -> Result<(), GatewayApplicationError> {
    let mut work = Work::default();
    for file in open_turn_transcripts(&context).await? {
        work.enqueue(file);
    }
    loop {
        let events = std::mem::take(&mut *pending.lock());
        for file in events.paths {
            work.enqueue(file);
        }
        if events.overflow {
            work.command(Some(Command::Wake), &context).await;
        }
        if events.terminal || events.overflow {
            work.command(Some(Command::Terminal), &context).await;
        }
        match receiver.try_recv() {
            Ok(command) => {
                if work.command(Some(command), &context).await {
                    return Ok(());
                }
                continue;
            }
            Err(mpsc::error::TryRecvError::Disconnected) => return Ok(()),
            Err(mpsc::error::TryRecvError::Empty) => {}
        }
        if work.project_ready(&context).await {
            continue;
        }
        if work.pending {
            if !work.retry.is_zero() {
                tokio::select! {
                    () = tokio::time::sleep(work.retry) => {}
                    command = receiver.recv() => {
                        if work.command(command, &context).await { return Ok(()) }
                    }
                }
                work.retry = Duration::ZERO;
                continue;
            }
            match work.sweep.step(&context).await {
                Ok(true) if work.resweep => {
                    work.sweep = Sweep::default();
                    work.resweep = false;
                }
                Ok(true) => {
                    work.pending = false;
                    work.sweep = Sweep::default();
                }
                Ok(false) => tokio::task::yield_now().await,
                Err(_) => {
                    work.sweep = Sweep::default();
                    work.retry = (work.retry.max(SETTLE_DELAY) * 2).min(MAX_RETRY_DELAY);
                }
            }
            continue;
        }
        if work.command(receiver.recv().await, &context).await {
            return Ok(());
        }
    }
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent observed facts, each read separately"
)]
#[derive(Default)]
struct Work {
    pending: bool,
    resweep: bool,
    sweep: Sweep,
    retry: Duration,
    changed: VecDeque<String>,
    changed_set: HashSet<String>,
    terminal: bool,
    terminal_resweep: bool,
    terminal_after: String,
}

impl Work {
    async fn project_ready(&mut self, context: &ProjectionContext) -> bool {
        if let Some(file) = self.changed.pop_front() {
            let result = match resolve_chat_file(context, &file).await {
                Ok(Some(chat)) => sync_chat_once(context, &chat).await,
                Ok(None) => Ok(false),
                Err(error) => Err(error),
            };
            match result {
                Ok(true) => self.changed.push_back(file),
                Ok(false) => {
                    self.changed_set.remove(&file);
                }
                Err(_) => {
                    self.changed.push_back(file);
                    self.retry = (self.retry.max(SETTLE_DELAY) * 2).min(MAX_RETRY_DELAY);
                    tokio::time::sleep(self.retry).await;
                }
            }
            tokio::task::yield_now().await;
            return true;
        }
        if self.terminal {
            match sync_deferred_step(context, &mut self.terminal_after).await {
                Ok(true) => {}
                Ok(false) if self.terminal_resweep => {
                    self.terminal_after.clear();
                    self.terminal_resweep = false;
                }
                Ok(false) => {
                    self.terminal = false;
                    self.terminal_after.clear();
                }
                Err(_) => {
                    self.retry = (self.retry.max(SETTLE_DELAY) * 2).min(MAX_RETRY_DELAY);
                    tokio::time::sleep(self.retry).await;
                }
            }
            tokio::task::yield_now().await;
            return true;
        }
        false
    }

    fn enqueue(&mut self, file: String) {
        if self.changed_set.insert(file.clone()) {
            self.changed.push_back(file);
        }
    }

    async fn command(&mut self, command: Option<Command>, context: &ProjectionContext) -> bool {
        match command {
            Some(Command::Wake) => {
                if self.pending {
                    self.resweep = true;
                } else {
                    self.pending = true;
                    self.retry = SETTLE_DELAY;
                }
            }
            Some(Command::Events) => {}
            Some(Command::Terminal) => {
                if self.terminal {
                    self.terminal_resweep = true;
                } else {
                    self.terminal = true;
                }
                // Only chats with an open turn or a staged outbound can be
                // waiting on a terminal record; the staged finals themselves
                // are replayed by the deferred sweep.
                match open_turn_transcripts(context).await {
                    Ok(files) => files.into_iter().for_each(|file| self.enqueue(file)),
                    Err(_) if self.pending => self.resweep = true,
                    Err(_) => self.pending = true,
                }
            }
            Some(Command::Refresh(chat, completion)) => {
                let result = sync_requested(context, &chat).await;
                let _ = completion.send(result);
            }
            Some(Command::Drain(completion)) => {
                let result = drain_open_turns(context).await;
                let _ = completion.send(result);
            }
            #[cfg(test)]
            Some(Command::Pause(entered, release)) => {
                let _ = entered.send(());
                let _ = release.await;
            }
            Some(Command::Close) | None => return true,
        }
        false
    }
}

#[derive(Default)]
struct Sweep {
    chat_cursor: i64,
    active_chat: Option<(i64, String)>,
    deferred: bool,
    deferred_after: String,
}

impl Sweep {
    // A single transcript record or staged final per step leaves room for
    // foreground refresh and close without running projection concurrently.
    async fn step(&mut self, context: &ProjectionContext) -> Result<bool, GatewayApplicationError> {
        if self.deferred {
            return Ok(!sync_deferred_step(context, &mut self.deferred_after).await?);
        }
        if self.active_chat.is_none() {
            let cursor = self.chat_cursor;
            self.active_chat = context
                .storage
                .execute(move |db| {
                    db.query_row(
                        "SELECT rowid,id FROM chats WHERE rowid>?1 ORDER BY rowid LIMIT 1",
                        [cursor],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()
                    .map_err(super::super::storage::AppStorageError::sqlite)
                })
                .await
                .map_err(super::super::app_error)?;
        }
        let Some((rowid, chat)) = self.active_chat.as_ref() else {
            self.deferred = true;
            return Ok(false);
        };
        if !sync_chat_once(context, chat).await? {
            self.chat_cursor = *rowid;
            self.active_chat = None;
        }
        Ok(false)
    }
}
async fn sync_chat(context: &ProjectionContext, chat: &str) -> Result<(), GatewayApplicationError> {
    while sync_chat_once(context, chat).await? {}
    Ok(())
}

async fn sync_requested(
    context: &ProjectionContext,
    chat: &str,
) -> Result<(), GatewayApplicationError> {
    sync_chat(context, chat).await?;
    while sync_deferred_once(context).await? {}
    Ok(())
}
fn lock<T>(value: &Mutex<T>) -> parking_lot::MutexGuard<'_, T> {
    value.lock()
}

async fn drain_open_turns(context: &ProjectionContext) -> Result<(), GatewayApplicationError> {
    // Existing checkpoints read only appended bytes, never whole transcripts.
    for file in open_turn_transcripts(context).await? {
        if let Some(chat) = resolve_chat_file(context, &file).await? {
            sync_chat(context, &chat).await?;
        }
    }
    while sync_deferred_once(context).await? {}
    Ok(())
}
