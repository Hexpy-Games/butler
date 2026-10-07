mod decode;
mod environment;
mod error;
mod guided;
mod process;
mod spool;
mod structured;

pub use error::{CommandCode, CommandError};
use parking_lot::Mutex;
use process::{ProcessHost, SystemProcesses};

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

/// What a guided command may do: anything inside the containment, or only observe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuidedAccess {
    FullAccessContained,
    ReadOnlyObservation,
    ContainedObservation,
}

/// A guided shell command with its workspace, timeout and access.
#[derive(Clone)]
pub struct GuidedCommandInput {
    pub command: String,
    pub cwd: Option<String>,
    pub workspace_root: PathBuf,
    pub butler_data: PathBuf,
    pub timeout_ms: Option<f64>,
    pub access: GuidedAccess,
    pub host_environment: HashMap<String, String>,
    pub abort: CancellationToken,
}

/// How a guided command ended (the header of its spooled payload).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidedSummary {
    pub command: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
}

#[derive(Clone, Debug)]
pub struct SpooledPayload {
    pub path: PathBuf,
    pub stdout_start: u64,
    pub stdout_len: u64,
    pub stderr_start: u64,
    pub stderr_len: u64,
}

/// A finished guided command and its spooled output.
#[derive(Clone, Debug)]
pub struct GuidedCommandOutput {
    pub summary: GuidedSummary,
    pub payload_source: SpooledPayload,
}

/// One executable step of a structured pipeline.
#[derive(Clone, Debug)]
pub struct CommandStep {
    pub executable: String,
    pub arguments: Vec<String>,
}

/// A structured command pipeline (or legacy shell command) to run.
pub struct StructuredCommandInput {
    pub steps: Vec<CommandStep>,
    pub cwd: Option<PathBuf>,
    pub environment: HashMap<String, Option<String>>,
    pub host_environment: HashMap<String, String>,
    pub inherit_environment: bool,
    pub stdin: String,
    pub timeout_ms: Option<f64>,
    pub abort: CancellationToken,
    pub legacy: Option<LegacyShell>,
}

/// A legacy shell command run through bash for compatibility.
pub struct LegacyShell {
    pub command: String,
    pub pipefail: bool,
    pub read_only_installation_root: Option<PathBuf>,
}

/// The captured output of a structured pipeline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StructuredCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    pub error: Option<CommandError>,
}

/// Owns running commands: admits submissions and cancels them on close.
#[derive(Clone)]
pub struct Commands {
    inner: Arc<Owner>,
}

struct Owner {
    state: Mutex<OwnerState>,
    idle: Notify,
    host: Arc<dyn ProcessHost>,
}

struct OwnerState {
    closing: bool,
    next_id: u64,
    active: HashMap<u64, CancellationToken>,
}

struct Active {
    owner: Arc<Owner>,
    id: u64,
}

impl Drop for Active {
    fn drop(&mut self) {
        self.owner.state.lock().active.remove(&self.id);
        self.owner.idle.notify_waiters();
    }
}

impl Default for Commands {
    fn default() -> Self {
        Self::new()
    }
}

impl Commands {
    /// The guarded working directory a guided command would run in.
    pub fn guarded_directory(
        root: &std::path::Path,
        cwd: Option<&str>,
    ) -> Result<PathBuf, CommandError> {
        guided::guarded_directory(root, cwd)
    }
    /// The environment guided commands run with.
    pub fn tool_environment(
        host: &HashMap<String, String>,
        butler_data: &std::path::Path,
    ) -> Result<HashMap<String, String>, CommandError> {
        environment::guided_environment(host, butler_data)
    }
    /// An owner that runs real processes.
    pub fn new() -> Self {
        Self::with_host(Arc::new(SystemProcesses))
    }

    pub(crate) fn with_host(host: Arc<dyn ProcessHost>) -> Self {
        Self {
            inner: Arc::new(Owner {
                state: Mutex::new(OwnerState {
                    closing: false,
                    next_id: 0,
                    active: HashMap::new(),
                }),
                idle: Notify::new(),
                host,
            }),
        }
    }

    fn register(&self) -> Result<(Active, CancellationToken), CommandError> {
        let mut state = self.inner.state.lock();
        if state.closing {
            return Err(CommandError::new(
                CommandCode::CommandOwnerClosed,
                "Native command owner is closing",
            ));
        }
        let id = state.next_id;
        let Some(next_id) = state.next_id.checked_add(1) else {
            return Err(CommandError::new(
                CommandCode::CommandOwnerExhausted,
                "Native command operation ids are exhausted",
            ));
        };
        state.next_id = next_id;
        let shutdown = CancellationToken::new();
        state.active.insert(id, shutdown.clone());
        Ok((
            Active {
                owner: Arc::clone(&self.inner),
                id,
            },
            shutdown,
        ))
    }

    pub(crate) fn active_count(&self) -> usize {
        self.inner.state.lock().active.len()
    }

    /// Starts a guided command; the receiver resolves with its result.
    pub fn submit_guided(
        &self,
        input: GuidedCommandInput,
    ) -> Result<oneshot::Receiver<Result<GuidedCommandOutput, CommandError>>, CommandError> {
        let (active, shutdown) = self.register()?;
        let (tx, rx) = oneshot::channel();
        let host = Arc::clone(&self.inner.host);
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _active = active;
            guided::dispatch(&*host, input, shutdown, tx).await;
        });
        Ok(rx)
    }

    /// Starts a structured pipeline; the receiver resolves with its output.
    pub fn submit_structured(
        &self,
        input: StructuredCommandInput,
    ) -> Result<oneshot::Receiver<StructuredCommandOutput>, CommandError> {
        let (active, shutdown) = self.register()?;
        let (tx, rx) = oneshot::channel();
        let host = Arc::clone(&self.inner.host);
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _active = active;
            structured::dispatch(&*host, input, shutdown, tx).await;
        });
        Ok(rx)
    }

    /// Cancels running commands and waits until every one is reaped.
    pub async fn close(&self) {
        let tokens = {
            let mut state = self.inner.state.lock();
            state.closing = true;
            state.active.values().cloned().collect::<Vec<_>>()
        };
        for token in tokens {
            token.cancel();
        }
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active_count() == 0 {
                break;
            }
            notified.await;
        }
    }
}
