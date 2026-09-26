mod decode;
mod environment;
mod guided;
mod process;
mod spool;
mod structured;

use parking_lot::Mutex;
use process::{ProcessHost, SystemProcesses};

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub io_kind: Option<std::io::ErrorKind>,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            io_kind: None,
        }
    }
    #[expect(
        clippy::needless_pass_by_value,
        reason = "map_err/iterator adapter taking owned values"
    )]
    fn io(error: std::io::Error) -> Self {
        Self::new("command_io_failed", error.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GuidedAccess {
    FullAccessContained,
    ReadOnlyObservation,
}

pub(crate) struct GuidedCommandInput {
    pub command: String,
    pub cwd: Option<String>,
    pub workspace_root: PathBuf,
    pub butler_data: PathBuf,
    pub timeout_ms: Option<f64>,
    pub access: GuidedAccess,
    pub host_environment: HashMap<String, String>,
    pub abort: CancellationToken,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuidedSummary {
    pub command: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct SpooledPayload {
    pub path: PathBuf,
    pub stdout_start: u64,
    pub stdout_len: u64,
    pub stderr_start: u64,
    pub stderr_len: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct GuidedCommandOutput {
    pub summary: GuidedSummary,
    pub payload_source: SpooledPayload,
}

#[derive(Clone, Debug)]
pub(crate) struct CommandStep {
    pub executable: String,
    pub arguments: Vec<String>,
}

pub(crate) struct StructuredCommandInput {
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

pub(crate) struct LegacyShell {
    pub command: String,
    pub pipefail: bool,
    pub read_only_installation_root: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StructuredCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    pub error: Option<CommandError>,
}

#[derive(Clone)]
pub(crate) struct NativeCommands {
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

impl NativeCommands {
    pub(crate) fn guarded_directory(
        root: &std::path::Path,
        cwd: Option<&str>,
    ) -> Result<PathBuf, CommandError> {
        guided::guarded_directory(root, cwd)
    }
    pub(crate) fn tool_environment(
        host: &HashMap<String, String>,
        butler_data: &std::path::Path,
    ) -> Result<HashMap<String, String>, CommandError> {
        environment::guided_environment(host, butler_data)
    }
    pub(crate) fn new() -> Self {
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
                "command_owner_closed",
                "Native command owner is closing",
            ));
        }
        let id = state.next_id;
        let Some(next_id) = state.next_id.checked_add(1) else {
            return Err(CommandError::new(
                "command_owner_exhausted",
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

    pub(crate) fn submit_guided(
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

    pub(crate) fn submit_structured(
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

    pub(crate) async fn close(&self) {
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
