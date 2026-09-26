//! Process-owned, serial tool-output budgeting and durable original artifacts.

mod budget;
mod evidence;
mod prune;
mod reader;
mod wire;

#[cfg(test)]
mod tests;

use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

use super::{
    ContextBudgetOwner, ContextError, ContextResult, ExactText, OwnedDefaultTokenEstimator,
    ToolArtifactTextSlice,
};
use crate::json::JsonDocument;

pub(crate) trait ToolOutputIdentity: Send + Sync {
    fn now(&self) -> SystemTime;
    fn uuid(&self) -> String;
    /// Called once the artifact is fully assembled, just before it is written.
    fn before_artifact_write(&self) {}
}

#[derive(Clone, Debug)]
pub(crate) struct ShellCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum OutputModeInput {
    Present(serde_json::Value),
}

pub(crate) struct BudgetToolOutputInput {
    pub result: ShellCommandResult,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub max_model_tokens: Option<f64>,
    pub output_mode: OutputModeInput,
    pub validation_suite: Option<serde_json::Value>,
    pub retain_original: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct OutputPresentation {
    pub mode: &'static str,
    pub requested_max_tokens: Option<f64>,
    pub applied_max_tokens: usize,
    pub suppressed: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct ToolOutputArtifact {
    pub id: String,
    pub path: PathBuf,
    pub raw_tokens: f64,
    pub compact_tokens: f64,
    pub created_at: String,
    pub command: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct BudgetedToolOutput {
    pub stdout: ExactText,
    pub stderr: ExactText,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output_presentation: Option<OutputPresentation>,
    pub butler_tool_artifact: Option<ToolOutputArtifact>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactStream {
    Stdout,
    Stderr,
    Both,
}

pub(crate) struct ReadToolOutputInput {
    pub artifact_id: Option<String>,
    pub path: Option<PathBuf>,
    pub stream: ArtifactStream,
    pub offset_lines: Option<f64>,
    pub offset_chars: Option<f64>,
    pub search: Option<String>,
    pub limit_lines: Option<f64>,
    pub max_tokens: Option<f64>,
    pub max_artifact_scan_files: Option<usize>,
}

pub(crate) struct ReadToolEvidenceInput {
    pub artifact_id: Option<String>,
    pub path: Option<PathBuf>,
    pub offset_lines: Option<f64>,
    pub offset_chars: Option<f64>,
    pub limit_lines: Option<f64>,
    pub max_tokens: Option<f64>,
    pub max_artifact_scan_files: Option<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct ToolOutputArtifactMetadata {
    pub id: String,
    pub path: PathBuf,
    pub created_at: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub raw_tokens: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct FocusedToolOutputArtifactRead {
    pub ok: bool,
    pub error: Option<&'static str>,
    pub artifact: Option<ToolOutputArtifactMetadata>,
    pub stdout: Option<ToolArtifactTextSlice>,
    pub stderr: Option<ToolArtifactTextSlice>,
    pub requested_max_tokens: Option<f64>,
    pub applied_max_tokens: Option<usize>,
    pub requested_limit_lines: Option<f64>,
    pub applied_limit_lines: Option<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct PruneToolOutputInput {
    pub max_age_ms: Option<f64>,
    pub max_bytes: Option<f64>,
    pub protected_paths: Vec<PathBuf>,
    pub record_telemetry: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct PruneToolOutputResult {
    pub scanned: usize,
    pub deleted: usize,
    pub bytes_deleted: u64,
    pub remaining_bytes: u64,
    pub max_age_ms: f64,
    pub max_bytes: f64,
}

pub(crate) trait PruneMetricObserver: Send + Sync {
    fn observe_prune(
        &self,
        now_ms: f64,
        result: &PruneToolOutputResult,
        protected_count: usize,
    ) -> ContextResult<()>;
}

enum Job {
    Budget(
        BudgetToolOutputInput,
        oneshot::Sender<ContextResult<BudgetedToolOutput>>,
        OwnedSemaphorePermit,
    ),
    Read(
        ReadToolOutputInput,
        oneshot::Sender<ContextResult<FocusedToolOutputArtifactRead>>,
        OwnedSemaphorePermit,
    ),
    ReadEvidence(
        ReadToolEvidenceInput,
        oneshot::Sender<ContextResult<JsonDocument>>,
        OwnedSemaphorePermit,
    ),
    Prune(
        PruneToolOutputInput,
        oneshot::Sender<ContextResult<PruneToolOutputResult>>,
        OwnedSemaphorePermit,
    ),
    Close,
}

struct Admission {
    closing: bool,
    closed: bool,
    queue: mpsc::UnboundedSender<Job>,
}

#[derive(Clone)]
pub(crate) struct NativeToolOutput {
    admission: Arc<Mutex<Admission>>,
    slots: Arc<Semaphore>,
    drained: Arc<Notify>,
}

impl NativeToolOutput {
    pub(crate) fn new(
        butler_data: PathBuf,
        budget_owner: Arc<ContextBudgetOwner>,
        identity: Arc<dyn ToolOutputIdentity>,
        prune_metrics: Arc<dyn PruneMetricObserver>,
    ) -> Self {
        let (queue, mut receiver) = mpsc::unbounded_channel();
        let admission = Arc::new(Mutex::new(Admission {
            closing: false,
            closed: false,
            queue,
        }));
        let drained = Arc::new(Notify::new());
        // One operation may run while one more owns a queued payload.
        let slots = Arc::new(Semaphore::new(2));
        let worker_admission = Arc::downgrade(&admission);
        let worker_drained = Arc::clone(&drained);
        tokio::spawn(async move {
            while let Some(job) = receiver.recv().await {
                match job {
                    Job::Budget(input, reply, _permit) => {
                        let result = match budget_owner.owned_default_estimator().await {
                            Ok(estimator) => tokio::task::spawn_blocking({
                                let root = butler_data.clone();
                                let identity = Arc::clone(&identity);
                                move || budget::budget(&root, &estimator, identity.as_ref(), input)
                            })
                            .await
                            .unwrap_or_else(join_error),
                            Err(error) => Err(error),
                        };
                        let _ = reply.send(result);
                    }
                    Job::Read(input, reply, _permit) => {
                        let result = match budget_owner.owned_default_estimator().await {
                            Ok(estimator) => tokio::task::spawn_blocking({
                                let root = butler_data.clone();
                                move || reader::read(&root, &estimator, input)
                            })
                            .await
                            .unwrap_or_else(join_error),
                            Err(error) => Err(error),
                        };
                        let _ = reply.send(result);
                    }
                    Job::ReadEvidence(input, reply, _permit) => {
                        let result = match budget_owner.owned_default_estimator().await {
                            Ok(estimator) => tokio::task::spawn_blocking({
                                let root = butler_data.clone();
                                move || evidence::read(&root, &estimator, input)
                            })
                            .await
                            .unwrap_or_else(join_error),
                            Err(error) => Err(error),
                        };
                        let _ = reply.send(result);
                    }
                    Job::Prune(input, reply, _permit) => {
                        let result = tokio::task::spawn_blocking({
                            let root = butler_data.clone();
                            let identity = Arc::clone(&identity);
                            let metrics = Arc::clone(&prune_metrics);
                            move || prune::prune(&root, identity.as_ref(), metrics.as_ref(), input)
                        })
                        .await
                        .unwrap_or_else(join_error);
                        let _ = reply.send(result);
                    }
                    Job::Close => break,
                }
            }
            if let Some(admission) = worker_admission.upgrade() {
                admission.lock().closed = true;
            }
            worker_drained.notify_waiters();
        });
        Self {
            admission,
            slots,
            drained,
        }
    }

    fn enqueue(&self, job: Job) -> ContextResult<()> {
        let state = self.admission.lock();
        if state.closing {
            return Err(ContextError::new(
                "tool_output_closed",
                "Tool-output service is closed",
            ));
        }
        state
            .queue
            .send(job)
            .map_err(|_| ContextError::new("tool_output_closed", "Tool-output worker ended"))
    }

    async fn acquire_slot(&self) -> ContextResult<OwnedSemaphorePermit> {
        Arc::clone(&self.slots)
            .acquire_owned()
            .await
            .map_err(|_| ContextError::new("tool_output_closed", "Tool-output service is closed"))
    }

    pub(crate) async fn submit_budget(
        &self,
        input: BudgetToolOutputInput,
    ) -> ContextResult<oneshot::Receiver<ContextResult<BudgetedToolOutput>>> {
        let permit = self.acquire_slot().await?;
        let (reply, receiver) = oneshot::channel();
        self.enqueue(Job::Budget(input, reply, permit))?;
        Ok(receiver)
    }

    pub(crate) async fn submit_read(
        &self,
        input: ReadToolOutputInput,
    ) -> ContextResult<oneshot::Receiver<ContextResult<FocusedToolOutputArtifactRead>>> {
        let permit = self.acquire_slot().await?;
        let (reply, receiver) = oneshot::channel();
        self.enqueue(Job::Read(input, reply, permit))?;
        Ok(receiver)
    }

    pub(crate) async fn read_output_document(
        &self,
        input: ReadToolOutputInput,
    ) -> ContextResult<JsonDocument> {
        let read = self.submit_read(input).await?.await.map_err(|error| {
            ContextError::new("tool_output_completion_lost", error.to_string())
        })??;
        let encoded = read.to_json_document()?;
        JsonDocument::from_encoded(encoded)
            .map_err(|error| ContextError::new("tool_output_json_error", error.to_string()))
    }

    pub(crate) async fn read_evidence_document(
        &self,
        input: ReadToolEvidenceInput,
    ) -> ContextResult<JsonDocument> {
        let permit = self.acquire_slot().await?;
        let (reply, receiver) = oneshot::channel();
        self.enqueue(Job::ReadEvidence(input, reply, permit))?;
        receiver
            .await
            .map_err(|error| ContextError::new("tool_output_completion_lost", error.to_string()))?
    }

    pub(crate) async fn submit_prune(
        &self,
        input: PruneToolOutputInput,
    ) -> ContextResult<oneshot::Receiver<ContextResult<PruneToolOutputResult>>> {
        let permit = self.acquire_slot().await?;
        let (reply, receiver) = oneshot::channel();
        self.enqueue(Job::Prune(input, reply, permit))?;
        Ok(receiver)
    }

    pub(crate) async fn close(&self) {
        {
            let mut state = self.admission.lock();
            if !state.closing {
                state.closing = true;
                self.slots.close();
                let _ = state.queue.send(Job::Close);
            }
        }
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.admission.lock().closed {
                break;
            }
            notified.await;
        }
    }
}

fn join_error<T>(error: tokio::task::JoinError) -> ContextResult<T> {
    Err(ContextError::new(
        "tool_output_worker_failed",
        error.to_string(),
    ))
}
