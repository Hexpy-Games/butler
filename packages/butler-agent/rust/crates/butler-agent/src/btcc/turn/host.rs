use parking_lot::Mutex;
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::TurnFacade;
use super::ports::HostDependencies;
use crate::btcc::BtccCode;
use crate::btcc::{BtccError, TurnOutcome, TurnRequest};

pub(crate) struct Coordinator {
    facade: Arc<TurnFacade>,
    dependencies: Arc<dyn HostDependencies>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    closing: bool,
    active: HashMap<String, Arc<Flight<TurnOutcome>>>,
    active_stops: HashMap<u64, Arc<Flight<TurnOutcome>>>,
    next_stop_generation: u64,
    session_tails: HashMap<String, Arc<Flight<TurnOutcome>>>,
    close: Option<Arc<Flight<()>>>,
}

struct Flight<T> {
    result: AsyncMutex<Option<Result<T, BtccError>>>,
    task: AsyncMutex<Option<tokio::task::JoinHandle<()>>>,
    ready: Notify,
}

impl Coordinator {
    pub(super) fn new(facade: Arc<TurnFacade>, dependencies: Arc<dyn HostDependencies>) -> Self {
        Self {
            facade,
            dependencies,
            state: Mutex::new(State::default()),
        }
    }

    pub(super) async fn run(
        self: &Arc<Self>,
        request: TurnRequest,
    ) -> Result<TurnOutcome, BtccError> {
        let (flight, predecessor, leader) = {
            let mut state = self.state.lock();
            if state.closing {
                return Err(closing_error());
            }
            if let Some(active) = state.active.get(&request.turn_id) {
                (active.clone(), None, false)
            } else {
                let flight = Arc::new(Flight::new());
                let predecessor = state
                    .session_tails
                    .insert(request.session_id.clone(), flight.clone());
                state.active.insert(request.turn_id.clone(), flight.clone());
                (flight, predecessor, true)
            }
        };
        let cleanup_turn_id = request.turn_id.clone();
        let cleanup_session_id = request.session_id.clone();
        if leader {
            let coordinator = self.clone();
            let spawned = flight.clone();
            let task = tokio::spawn(async move {
                let turn_id = request.turn_id.clone();
                let session_id = request.session_id.clone();
                let result = AssertUnwindSafe(async {
                    if let Some(predecessor) = predecessor {
                        let _ = predecessor.wait().await;
                    }
                    coordinator.facade.run(request).await
                })
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(panicked_task_error()));
                spawned.complete(result).await;
                coordinator.remove_flight(&turn_id, &session_id, &spawned);
            });
            flight.attach(task).await;
        }
        let result = flight.wait().await;
        let mut state = self.state.lock();
        if state
            .active
            .get(&cleanup_turn_id)
            .is_some_and(|value| Arc::ptr_eq(value, &flight))
        {
            state.active.remove(&cleanup_turn_id);
        }
        if state
            .session_tails
            .get(&cleanup_session_id)
            .is_some_and(|value| Arc::ptr_eq(value, &flight))
        {
            state.session_tails.remove(&cleanup_session_id);
        }
        result
    }

    pub(super) async fn stop(self: &Arc<Self>, turn_id: &str) -> Result<TurnOutcome, BtccError> {
        let (generation, flight) = {
            let mut state = self.state.lock();
            if state.closing {
                return Err(closing_error());
            }
            let generation = state.next_stop_generation;
            state.next_stop_generation = generation.checked_add(1).ok_or_else(|| {
                BtccError::detected(
                    BtccCode::BtccStopGenerationExhausted,
                    "BTCC Stop operation generation exhausted",
                )
            })?;
            let flight = Arc::new(Flight::new());
            state.active_stops.insert(generation, flight.clone());
            (generation, flight)
        };
        let coordinator = self.clone();
        let spawned = flight.clone();
        let turn_id = turn_id.to_owned();
        let task = tokio::spawn(async move {
            let result = AssertUnwindSafe(coordinator.facade.stop(&turn_id))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(panicked_task_error()));
            spawned.complete(result).await;
            coordinator.remove_stop(generation, &spawned);
        });
        flight.attach(task).await;
        let result = flight.wait().await;
        self.remove_stop(generation, &flight);
        result
    }

    pub(super) async fn close(self: &Arc<Self>) -> Result<(), BtccError> {
        let (close, leader, active) = {
            let mut state = self.state.lock();
            if let Some(close) = &state.close {
                (close.clone(), false, Vec::new())
            } else {
                state.closing = true;
                let close = Arc::new(Flight::new());
                let active = state
                    .active
                    .values()
                    .chain(state.active_stops.values())
                    .cloned()
                    .collect();
                state.close = Some(close.clone());
                (close, true, active)
            }
        };
        if leader {
            let coordinator = self.clone();
            let completion = close.clone();
            let task = tokio::spawn(async move {
                let result = AssertUnwindSafe(async {
                    for flight in active {
                        let _ = flight.wait().await;
                    }
                    {
                        let mut state = coordinator.state.lock();
                        state.active.clear();
                        state.active_stops.clear();
                        state.session_tails.clear();
                    }
                    coordinator.dependencies.close().await
                })
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(panicked_task_error()));
                completion.complete(result).await;
            });
            close.attach(task).await;
        }
        close.wait().await
    }

    #[cfg(test)]
    pub(super) fn active_count(&self) -> usize {
        self.state.lock().active.len()
    }

    #[cfg(test)]
    pub(super) fn session_tail_count(&self) -> usize {
        self.state.lock().session_tails.len()
    }

    #[cfg(test)]
    pub(super) fn active_stop_count(&self) -> usize {
        self.state.lock().active_stops.len()
    }

    fn remove_flight(&self, turn_id: &str, session_id: &str, flight: &Arc<Flight<TurnOutcome>>) {
        let mut state = self.state.lock();
        if state
            .active
            .get(turn_id)
            .is_some_and(|value| Arc::ptr_eq(value, flight))
        {
            state.active.remove(turn_id);
        }
        if state
            .session_tails
            .get(session_id)
            .is_some_and(|value| Arc::ptr_eq(value, flight))
        {
            state.session_tails.remove(session_id);
        }
    }

    fn remove_stop(&self, generation: u64, flight: &Arc<Flight<TurnOutcome>>) {
        let mut state = self.state.lock();
        if state
            .active_stops
            .get(&generation)
            .is_some_and(|value| Arc::ptr_eq(value, flight))
        {
            state.active_stops.remove(&generation);
        }
    }
}

impl<T> Flight<T> {
    fn new() -> Self {
        Self {
            result: AsyncMutex::new(None),
            task: AsyncMutex::new(None),
            ready: Notify::new(),
        }
    }

    async fn complete(&self, result: Result<T, BtccError>) {
        *self.result.lock().await = Some(result);
        self.ready.notify_waiters();
    }

    async fn attach(&self, task: tokio::task::JoinHandle<()>) {
        *self.task.lock().await = Some(task);
        self.ready.notify_waiters();
    }
}

impl<T: Clone> Flight<T> {
    async fn wait(&self) -> Result<T, BtccError> {
        loop {
            let notified = self.ready.notified();
            if let Some(result) = self.result.lock().await.clone() {
                return result;
            }
            let mut task = self.task.lock().await;
            if let Some(handle) = task.as_mut() {
                if let Err(error) = handle.await {
                    let failure = BtccError::detected(BtccCode::BtccTaskFailed, error.to_string());
                    *self.result.lock().await = Some(Err(failure.clone()));
                    task.take();
                    self.ready.notify_waiters();
                    return Err(failure);
                }
                task.take();
                continue;
            }
            drop(task);
            notified.await;
        }
    }
}

fn closing_error() -> BtccError {
    BtccError::detected(BtccCode::BtccClosing, "BTCC is closing")
}

fn panicked_task_error() -> BtccError {
    BtccError::detected(BtccCode::BtccTaskFailed, "BTCC owned task panicked")
}
