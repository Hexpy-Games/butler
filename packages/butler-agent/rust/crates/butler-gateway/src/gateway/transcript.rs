//! Bounded transcript append owner for actual App transport delivery.

mod error;
mod event;
mod file;

pub use error::TranscriptCode;
pub(crate) use error::TranscriptError;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;

use serde_json::Value;
use tokio::sync::{Mutex, mpsc, oneshot};

use super::AppIdentityClock;

const CAPACITY: usize = 64;

type TranscriptResult<T> = Result<T, TranscriptError>;

struct Job {
    session_id: String,
    events: Vec<event::TranscriptEvent>,
    result: oneshot::Sender<TranscriptResult<()>>,
}
struct State {
    sender: Option<mpsc::Sender<Job>>,
    worker: Option<JoinHandle<()>>,
}

pub struct TranscriptWriter {
    clock: Arc<dyn AppIdentityClock>,
    state: Mutex<State>,
}

impl TranscriptWriter {
    pub fn new(data_root: PathBuf, clock: Arc<dyn AppIdentityClock>) -> std::io::Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<Job>(CAPACITY);
        let worker = std::thread::Builder::new()
            .name("butler-transcript-append".into())
            .spawn(move || {
                while let Some(job) = receiver.blocking_recv() {
                    let outcome = file::append(&data_root, &job.session_id, &job.events);
                    let _ = job.result.send(outcome);
                }
            })?;
        Ok(Self {
            clock,
            state: Mutex::new(State {
                sender: Some(sender),
                worker: Some(worker),
            }),
        })
    }

    pub async fn append_outbound(
        &self,
        session_id: String,
        action: Value,
        delivery: Value,
        metadata: Value,
    ) -> TranscriptResult<()> {
        let events = event::outbound(self.clock.as_ref(), &session_id, action, delivery, metadata)?;
        self.submit(session_id, events).await
    }

    pub async fn append_lifecycle(
        &self,
        session_id: String,
        role: String,
        state: String,
        reason: Option<String>,
        metadata: Value,
    ) -> TranscriptResult<()> {
        let events = event::lifecycle(
            self.clock.as_ref(),
            &session_id,
            &role,
            &state,
            reason.as_deref(),
            metadata,
        )?;
        self.submit(session_id, events).await
    }

    async fn submit(
        &self,
        session_id: String,
        events: Vec<event::TranscriptEvent>,
    ) -> TranscriptResult<()> {
        let (reply, result) = oneshot::channel();
        let state = self.state.lock().await;
        state
            .sender
            .as_ref()
            .ok_or_else(closed)?
            .send(Job {
                session_id,
                events,
                result: reply,
            })
            .await
            .map_err(|source| closed().with_source(source))?;
        drop(state);
        result
            .await
            .map_err(|source| closed().with_source(source))?
    }

    /// Best-effort drain for the service's forced deadline thread. It does not
    /// depend on Tokio workers, which may be blocked during startup or shutdown.
    pub fn close_on_deadline(&self, grace: std::time::Duration) -> bool {
        let Ok(mut state) = self.state.try_lock() else {
            return false;
        };
        state.sender.take();
        let Some(worker) = state.worker.take() else {
            return true;
        };
        drop(state);
        let (flushed, receipt) = std::sync::mpsc::sync_channel(1);
        if std::thread::Builder::new()
            .name("butler-transcript-drain".into())
            .spawn(move || {
                let _ = flushed.send(worker.join().is_ok());
            })
            .is_err()
        {
            return false;
        }
        receipt.recv_timeout(grace).unwrap_or(false)
    }

    pub async fn close(&self) -> TranscriptResult<()> {
        let mut state = self.state.lock().await;
        state.sender.take();
        if let Some(worker) = state.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .map_err(|error| {
                    TranscriptError::new(TranscriptCode::TranscriptJoinFailed, error.to_string())
                        .with_source(error)
                })?
                // A panic payload is not an Error; the code records the failure.
                .map_err(|_panic_payload| closed())?;
        }
        Ok(())
    }
}

fn closed() -> TranscriptError {
    TranscriptError::new(
        TranscriptCode::TranscriptWriterClosed,
        "Transcript writer is closed",
    )
}
