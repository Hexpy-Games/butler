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

use compaction::{CompactResult, compact, terminal_page};

const COMMAND_CAPACITY: usize = 64;
const PENDING_CAPACITY: usize = 256;
const SEMANTIC_BATCH_SIZE: usize = 4;
#[derive(Clone)]
pub(super) struct RetentionWake(mpsc::Sender<Command>);
impl RetentionWake {
    pub(super) async fn turn(&self, turn_id: String) -> Result<(), GatewayApplicationError> {
        self.0
            .send(Command::Turn(turn_id))
            .await
            .map_err(|_| GatewayApplicationError::Internal)
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
                        .map_err(|_| GatewayApplicationError::Internal)
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

async fn run(
    storage: AppStorage,
    mut receiver: mpsc::Receiver<Command>,
    cancel: CancellationToken,
    cursor_signal: Arc<CursorSignal>,
) -> Result<(), GatewayApplicationError> {
    let mut semantic_pending = VecDeque::<String>::new();
    let mut maintenance_pending = VecDeque::<String>::new();
    let mut recoveries = Vec::<String>::new();
    let mut cursor_waits = HashMap::<String, i64>::new();
    let mut sweep_cursor = Some(0_i64);
    let mut semantic_tick = tokio::time::interval(Duration::from_millis(25));
    let mut maintenance_tick = tokio::time::interval(Duration::from_millis(250));
    semantic_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    maintenance_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        let latest =
            i64::try_from(cursor_signal.latest.load(Ordering::Relaxed)).unwrap_or(i64::MAX);
        if let Some(turn) = cursor_waits
            .iter()
            .find_map(|(turn, wake)| (*wake <= latest).then_some(turn.clone()))
        {
            cursor_waits.remove(&turn);
            push(&mut maintenance_pending, turn);
        }
        if cursor_waits.len() == PENDING_CAPACITY {
            tokio::select! {
                ()=cancel.cancelled()=>return Ok(()),
                ()=cursor_signal.changed.notified()=>{},
                command=receiver.recv()=>if stop(command,&mut semantic_pending,&mut sweep_cursor){return Ok(())},
            }
            continue;
        }
        if semantic_pending.is_empty()
            && maintenance_pending.is_empty()
            && sweep_cursor.is_none()
            && cursor_waits.is_empty()
        {
            tokio::select! {
                ()=cancel.cancelled()=>return Ok(()),
                command=receiver.recv()=>if stop(command,&mut semantic_pending,&mut sweep_cursor){return Ok(())},
            }
            continue;
        }
        if semantic_pending.is_empty() && maintenance_pending.is_empty() && sweep_cursor.is_none() {
            tokio::select! {
                ()=cancel.cancelled()=>return Ok(()),
                ()=cursor_signal.changed.notified()=>{},
                command=receiver.recv()=>if stop(command,&mut semantic_pending,&mut sweep_cursor){return Ok(())},
            }
            continue;
        }
        tokio::select! {
            ()=cancel.cancelled()=>return Ok(()),
            ()=cursor_signal.changed.notified()=>{},
            command=receiver.recv()=>if stop(command,&mut semantic_pending,&mut sweep_cursor){return Ok(())},
            _=semantic_tick.tick(),if !semantic_pending.is_empty()=>{
                for _ in 0..SEMANTIC_BATCH_SIZE {
                    let Some(turn)=semantic_pending.pop_front() else {break};
                    compact_one(&storage,turn,&mut maintenance_pending,&mut recoveries,&mut cursor_waits).await;
                }
            }
            _=maintenance_tick.tick(),if !maintenance_pending.is_empty() || sweep_cursor.is_some()=>{
                if let Some(turn)=maintenance_pending.pop_front(){
                    compact_one(&storage,turn,&mut maintenance_pending,&mut recoveries,&mut cursor_waits).await;
                }else if let Some(cursor)=sweep_cursor{
                    match storage.execute(move|db|terminal_page(db,cursor)).await{
                        Ok(page)=>{
                            for turn in page.0{
                                if !cursor_waits.contains_key(&turn){push(&mut maintenance_pending,turn)}
                            }
                            sweep_cursor=page.1;
                        }
                        Err(_)=>sweep_cursor=None,
                    }
                }
            }
        }
    }
}

fn stop(
    command: Option<Command>,
    semantic_pending: &mut VecDeque<String>,
    sweep_cursor: &mut Option<i64>,
) -> bool {
    match command {
        Some(Command::Turn(turn)) => push(semantic_pending, turn),
        Some(Command::Sweep) => *sweep_cursor = Some(0),
        Some(Command::Close) | None => return true,
    }
    false
}

async fn compact_one(
    storage: &AppStorage,
    turn: String,
    pending: &mut VecDeque<String>,
    recoveries: &mut Vec<String>,
    cursor_waits: &mut HashMap<String, i64>,
) {
    let owned_turn = turn.clone();
    match storage.execute(move |db| compact(db, &owned_turn)).await {
        Ok(result) => {
            recoveries.retain(|value| value != &turn);
            cursor_waits.remove(&turn);
            match result {
                CompactResult::Complete => {}
                CompactResult::Pending => push(pending, turn),
                CompactResult::Waiting(cursor) => {
                    if cursor_waits.len() < PENDING_CAPACITY {
                        cursor_waits.insert(turn, cursor);
                    } else {
                        push(pending, turn);
                    }
                }
            }
        }
        Err(_) => {
            if recoveries.contains(&turn) {
                recoveries.retain(|value| value != &turn);
            } else if recoveries.len() < PENDING_CAPACITY {
                recoveries.push(turn.clone());
                push(pending, turn);
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
