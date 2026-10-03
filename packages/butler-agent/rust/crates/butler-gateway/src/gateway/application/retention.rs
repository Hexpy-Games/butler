//! Bounded terminal-turn snapshot compaction owner.

use parking_lot::Mutex;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use tokio::{
    sync::{Notify, mpsc},
    task::JoinHandle,
    time::MissedTickBehavior,
};
use tokio_util::sync::CancellationToken;

use super::{AppStorage, GatewayApplicationError, events::EventSubscribers};

mod compaction;
mod drain;
mod sweep;

use compaction::{CompactResult, compact};

const COMMAND_CAPACITY: usize = 64;
const PENDING_CAPACITY: usize = 256;
const SEMANTIC_BATCH_SIZE: usize = 4;
/// Pause between background steps, so foreground storage work interleaves.
const MAINTENANCE_TICK: Duration = Duration::from_millis(5);
/// Removed events after which an idle worker checkpoints the WAL.
const CHECKPOINT_AFTER_DELETES: usize = 1_000;
#[derive(Clone)]
pub(super) struct RetentionWake(mpsc::Sender<Command>);
impl RetentionWake {
    pub(super) async fn turn(&self, turn_id: String) -> Result<(), GatewayApplicationError> {
        self.0
            .send(Command::Turn(turn_id))
            .await
            .map_err(GatewayApplicationError::internal_from)
    }
}

pub(super) struct RetentionOwner {
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
struct CursorSignal {
    latest: AtomicU64,
    changed: Notify,
}
enum Command {
    Turn(String),
    Sweep,
    Close,
}

impl RetentionOwner {
    pub(super) fn start(
        storage: AppStorage,
        subscribers: &EventSubscribers,
        initial_cursor: u64,
    ) -> (Self, RetentionWake) {
        let (sender, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let cancellation = CancellationToken::new();
        let cursor = Arc::new(CursorSignal {
            latest: AtomicU64::new(initial_cursor),
            changed: Notify::new(),
        });
        let cursor_observer = Arc::clone(&cursor);
        subscribers.observe_cursor(Arc::new(move |value| {
            cursor_observer.latest.fetch_max(value, Ordering::Relaxed);
            cursor_observer.changed.notify_one();
        }));
        let task = tokio::spawn(run(storage, receiver, cancellation.clone(), cursor));
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
        let _ = sender.try_send(Command::Sweep);
        (owner, RetentionWake(sender))
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
                        .and_then(|v| v);
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

    #[cfg(test)]
    pub(super) async fn schedule(&self, turn_id: String) {
        let _ = self.inner.sender.send(Command::Turn(turn_id)).await;
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.cancellation.cancel();
        let _ = self.sender.try_send(Command::Close);
    }
}

/// What the retention task has queued and how far its sweep has come.
struct Worker {
    storage: AppStorage,
    semantic_pending: VecDeque<String>,
    maintenance_pending: VecDeque<String>,
    recoveries: Vec<String>,
    cursor_waits: HashMap<String, i64>,
    /// Where the next sweep page starts; `None` when no sweep is running.
    sweep_cursor: Option<i64>,
    /// Turns up to here were settled when the sweep last started or finished.
    settled_through: i64,
    /// Sweep or compaction progress the persisted position has not seen yet.
    position_stale: bool,
    /// In-memory watermark scan; persisted only after its final page.
    watermark_scan: Option<i64>,
    /// Events removed since the last checkpoint.
    deleted: usize,
}

impl Worker {
    async fn start(storage: AppStorage) -> Self {
        let settled_through = storage.read(sweep::read_watermark).await.unwrap_or(0);
        Self {
            storage,
            semantic_pending: VecDeque::new(),
            maintenance_pending: VecDeque::new(),
            recoveries: Vec::new(),
            cursor_waits: HashMap::new(),
            sweep_cursor: Some(settled_through),
            settled_through,
            position_stale: true,
            watermark_scan: None,
            deleted: 0,
        }
    }

    fn has_work(&self) -> bool {
        !self.semantic_pending.is_empty()
            || !self.maintenance_pending.is_empty()
            || self.sweep_cursor.is_some()
            || self.watermark_scan.is_some()
    }

    /// Returns true when the owner should stop.
    fn accept(&mut self, command: Option<Command>) -> bool {
        match command {
            Some(Command::Turn(turn)) => push(&mut self.semantic_pending, turn),
            Some(Command::Sweep) => self.sweep_cursor = Some(self.settled_through),
            Some(Command::Close) | None => return true,
        }
        self.watermark_scan = None;
        self.position_stale = true;
        false
    }

    /// Moves a turn whose replay tail has passed back to the maintenance queue.
    fn wake_ready(&mut self, latest: i64) {
        let ready = self
            .cursor_waits
            .iter()
            .find_map(|(turn, wake)| (*wake <= latest).then_some(turn.clone()));
        if let Some(turn) = ready {
            self.cursor_waits.remove(&turn);
            push(&mut self.maintenance_pending, turn);
        }
    }

    async fn sweep_page(&mut self) {
        let Some(cursor) = self.sweep_cursor else {
            return;
        };
        match self
            .storage
            .read(move |db| sweep::needing_work_page(db, cursor))
            .await
        {
            Ok((turns, next)) => {
                for turn in turns {
                    if !self.cursor_waits.contains_key(&turn) {
                        push(&mut self.maintenance_pending, turn);
                    }
                }
                self.sweep_cursor = next;
                self.position_stale = true;
            }
            Err(_) => self.sweep_cursor = None,
        }
    }

    async fn compact_one(&mut self, turn: String) {
        let owned_turn = turn.clone();
        match self
            .storage
            .execute(move |db| compact(db, &owned_turn))
            .await
        {
            Ok(step) => {
                self.recoveries.retain(|value| value != &turn);
                self.cursor_waits.remove(&turn);
                self.deleted += step.deleted;
                self.position_stale = true;
                match step.result {
                    CompactResult::Complete => {}
                    CompactResult::Pending => push(&mut self.maintenance_pending, turn),
                    CompactResult::Waiting(cursor) => {
                        if self.cursor_waits.len() < PENDING_CAPACITY {
                            self.cursor_waits.insert(turn, cursor);
                        } else {
                            push(&mut self.maintenance_pending, turn);
                        }
                    }
                }
            }
            Err(_) => {
                if self.recoveries.contains(&turn) {
                    self.recoveries.retain(|value| value != &turn);
                } else if self.recoveries.len() < PENDING_CAPACITY {
                    self.recoveries.push(turn.clone());
                    push(&mut self.maintenance_pending, turn);
                }
            }
        }
    }

    async fn scan_watermark_page(&mut self) {
        let Some(from) = self.watermark_scan else {
            return;
        };
        match self
            .storage
            .read(move |db| sweep::scan_watermark_page(db, from))
            .await
        {
            Ok((settled, true)) => self.watermark_scan = Some(settled),
            Ok((settled, false)) => {
                self.watermark_scan = None;
                if self
                    .storage
                    .execute(move |db| sweep::write_watermark(db, settled))
                    .await
                    .is_ok()
                {
                    self.settled_through = settled;
                }
            }
            Err(_) => self.watermark_scan = None,
        }
    }

    /// Once the sweep has no page left and nothing is being compacted: start
    /// watermark inspection and fold a large WAL back after big deletes.
    async fn settle(&mut self) {
        if self.sweep_cursor.is_some()
            || !self.semantic_pending.is_empty()
            || !self.maintenance_pending.is_empty()
        {
            return;
        }
        if self.position_stale {
            self.position_stale = false;
            self.watermark_scan = Some(self.settled_through);
            return;
        }
        if self.deleted >= CHECKPOINT_AFTER_DELETES {
            self.deleted = 0;
            let _best_effort = self.storage.checkpoint().await;
        }
    }
}

async fn run(
    storage: AppStorage,
    mut receiver: mpsc::Receiver<Command>,
    cancel: CancellationToken,
    cursor_signal: Arc<CursorSignal>,
) -> Result<(), GatewayApplicationError> {
    let mut worker = Worker::start(storage).await;
    let mut semantic_tick = tokio::time::interval(Duration::from_millis(25));
    let mut maintenance_tick = tokio::time::interval(MAINTENANCE_TICK);
    semantic_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    maintenance_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        let latest =
            i64::try_from(cursor_signal.latest.load(Ordering::Relaxed)).unwrap_or(i64::MAX);
        worker.wake_ready(latest);
        if worker.cursor_waits.len() == PENDING_CAPACITY || !worker.has_work() {
            worker.settle().await;
            if worker.has_work() && worker.cursor_waits.len() != PENDING_CAPACITY {
                continue;
            }
            // Parked turns wait for the event cursor; with none, only commands wake it.
            let watching_cursor = !worker.cursor_waits.is_empty();
            tokio::select! {
                ()=cancel.cancelled()=>return Ok(()),
                ()=cursor_signal.changed.notified(),if watching_cursor=>{},
                command=receiver.recv()=>if worker.accept(command){return Ok(())},
            }
            continue;
        }
        tokio::select! {
            ()=cancel.cancelled()=>return Ok(()),
            ()=cursor_signal.changed.notified()=>{},
            command=receiver.recv()=>if worker.accept(command){return Ok(())},
            _=semantic_tick.tick(),if !worker.semantic_pending.is_empty()=>{
                for _ in 0..SEMANTIC_BATCH_SIZE {
                    let Some(turn)=worker.semantic_pending.pop_front() else {break};
                    worker.compact_one(turn).await;
                }
            }
            _=maintenance_tick.tick(),if !worker.maintenance_pending.is_empty() || worker.sweep_cursor.is_some() || worker.watermark_scan.is_some()=>{
                if let Some(turn)=worker.maintenance_pending.pop_front(){
                    worker.compact_one(turn).await;
                }else if worker.sweep_cursor.is_some(){
                    worker.sweep_page().await;
                }else{
                    worker.scan_watermark_page().await;
                }
            }
        }
    }
}

fn push(queue: &mut VecDeque<String>, turn: String) {
    if queue.len() < PENDING_CAPACITY && !queue.contains(&turn) {
        queue.push_back(turn);
    }
}
fn lock<T>(value: &Mutex<T>) -> parking_lot::MutexGuard<'_, T> {
    value.lock()
}
