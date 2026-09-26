//! Bounded transcript append owner for actual App transport delivery.

mod event;
mod file;

use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;

use serde_json::Value;
use tokio::sync::{Mutex, mpsc, oneshot};

use super::AppIdentityClock;

const CAPACITY: usize = 64;

type TranscriptResult<T> = Result<T, TranscriptError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TranscriptError {
    pub code: &'static str,
    pub message: String,
}
impl TranscriptError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for TranscriptError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for TranscriptError {}

struct Job {
    session_id: String,
    events: Vec<event::TranscriptEvent>,
    result: oneshot::Sender<TranscriptResult<()>>,
}
struct State {
    sender: Option<mpsc::Sender<Job>>,
    worker: Option<JoinHandle<()>>,
}

pub(crate) struct NativeTranscriptWriter {
    clock: Arc<dyn AppIdentityClock>,
    state: Mutex<State>,
}

impl NativeTranscriptWriter {
    pub(crate) fn new(
        data_root: PathBuf,
        clock: Arc<dyn AppIdentityClock>,
    ) -> std::io::Result<Self> {
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

    pub(crate) async fn append_outbound(
        &self,
        session_id: String,
        action: Value,
        delivery: Value,
        metadata: Value,
    ) -> TranscriptResult<()> {
        let events = event::outbound(self.clock.as_ref(), &session_id, action, delivery, metadata)?;
        self.submit(session_id, events).await
    }

    pub(crate) async fn append_lifecycle(
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
            .map_err(|_| closed())?;
        drop(state);
        result.await.map_err(|_| closed())?
    }

    pub(crate) async fn close(&self) -> TranscriptResult<()> {
        let mut state = self.state.lock().await;
        state.sender.take();
        if let Some(worker) = state.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .map_err(|error| TranscriptError::new("transcript_join_failed", error.to_string()))?
                .map_err(|_| closed())?;
        }
        Ok(())
    }
}

fn closed() -> TranscriptError {
    TranscriptError::new("transcript_writer_closed", "Transcript writer is closed")
}

#[cfg(test)]
mod tests;
