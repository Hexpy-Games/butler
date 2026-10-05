//! Stop requests and the exit status they produce.
//!
//! The host's stop requests (SIGTERM and SIGINT; console control events on
//! Windows, see `butler_platform::process_control::shutdown_requests`) are
//! listened for from the start of the service, so a stop that arrives while
//! the service is still starting ends it cleanly instead of killing it with
//! the signal. Every other source of a stop (the shutdown flag, the App
//! releasing its lease, and on Windows the control endpoint's `service_stop`
//! command) requests the same [`StopSignal`]. A requested stop exits 0; an exit
//! nobody asked for (a crash or unrecoverable infrastructure failure)
//! exits non-zero. Supervisors depend on it: the App reads the stop intent,
//! and launchd (`KeepAlive: {SuccessfulExit: false}`) and systemd
//! (`Restart=on-failure`) restart only an Agent that exits non-zero.

use std::path::PathBuf;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use butler_platform::process_control::shutdown_requests;
use tokio::sync::watch;

use butler_turn::btcc::BtccError;

use crate::host::ResolvedInstallation;
use butler_gateway::gateway::TranscriptWriter;

/// Error code of a startup that a stop request ended.
pub(super) const START_CANCELLED: &str = "native_service_start_cancelled";

/// Every stop has a deadline shorter than the controller's 8 s SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(6);

/// Whether a stop was requested: SIGTERM, SIGINT, the shutdown flag or the
/// App releasing its foreground lease.
#[derive(Clone)]
pub(super) struct StopSignal {
    inner: Arc<Inner>,
}

struct Inner {
    version: String,
    requested: watch::Sender<bool>,
    /// DATA and the instance nonce, once the instance record is published.
    instance: OnceLock<(PathBuf, String, ResolvedInstallation)>,
    writer: OnceLock<Arc<TranscriptWriter>>,
    completed: AtomicBool,
    cancellation: tokio_util::sync::CancellationToken,
}

impl StopSignal {
    /// Starts listening for the host's stop requests (SIGTERM and SIGINT).
    pub(super) fn listen(version: String) -> std::io::Result<Self> {
        let mut requests = shutdown_requests()?;
        let stop = Self {
            inner: Arc::new(Inner {
                version,
                requested: watch::Sender::new(false),
                instance: OnceLock::new(),
                writer: OnceLock::new(),
                completed: AtomicBool::new(false),
                cancellation: tokio_util::sync::CancellationToken::new(),
            }),
        };
        let listener = stop.clone();
        tokio::spawn(async move {
            requests.recv().await;
            listener.request_controlled();
        });
        if std::env::var_os(crate::host::service::instance_identity::CLI_SUPERVISOR_NONCE).is_some()
        {
            let lease = butler_platform::process_control::StdinLease::capture()?;
            let owner_stop = stop.clone();
            tokio::spawn(async move {
                let _ = lease.closed().await;
                owner_stop.request_controlled();
            });
        }
        Ok(stop)
    }

    /// Names the published instance, so a signal can be matched to the stop
    /// intent a controller wrote for it.
    pub(super) fn attach(
        &self,
        data_root: PathBuf,
        nonce: &str,
        installation: ResolvedInstallation,
    ) {
        let _ = self
            .inner
            .instance
            .set((data_root, nonce.to_owned(), installation));
    }

    /// All host and controller stops share one grace deadline.
    pub(super) fn request_controlled(&self) {
        self.request();
    }

    /// Records a stop request.
    pub(super) fn request(&self) {
        if !self.inner.requested.send_replace(true) {
            super::super::diagnostics::lifecycle(
                &self.inner.version,
                "stop",
                "requested_stop",
                "Service is stopping on request.",
            );
            super::super::shutdown_trace::event("stop_requested");
            self.inner.cancellation.cancel();
            exit_after_grace(self.inner.clone());
        }
    }

    /// Whether a stop was requested.
    pub(super) fn requested(&self) -> bool {
        *self.inner.requested.borrow()
    }

    /// Resolves once a stop is requested.
    pub(super) async fn wait(&self) {
        let mut requested = self.inner.requested.subscribe();
        // The sender lives in `self`, so the channel cannot close here.
        let _ = requested.wait_for(|requested| *requested).await;
    }

    /// The error that ends a startup a stop request interrupted.
    pub(super) fn cancelled_startup() -> BtccError {
        BtccError::relayed(START_CANCELLED, "a stop was requested during startup")
    }

    /// The service's result as the process reports it: a requested stop is a
    /// success (`None` when it ended startup before a session was bound), even
    /// when closing reported an error, which is logged. Any other failure
    /// stays a failure.
    pub(super) fn settle(
        &self,
        result: Result<String, BtccError>,
        log: impl FnOnce(&str),
    ) -> Result<Option<String>, BtccError> {
        self.inner.completed.store(true, Ordering::Release);
        super::super::shutdown_trace::event("stop_settled");
        match result {
            Ok(session) => Ok(Some(session)),
            Err(error) if self.requested() || error.code() == START_CANCELLED => {
                log(&format!(
                    "[native-butler] stopped on request code={}",
                    error.code()
                ));
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Whether the shutdown flag at `path` stops this instance: a flag that
    /// names another instance was left by a controller that died before it
    /// removed it, and is removed here; one without a nonce stops any.
    pub(super) fn flag_requested(&self, path: &std::path::Path) -> bool {
        let Ok(text) = std::fs::read_to_string(path) else {
            return path.exists();
        };
        let named = text.trim().strip_prefix("stop ").map(str::trim);
        let ours = self
            .inner
            .instance
            .get()
            .map(|(_, nonce, _)| nonce.as_str());
        match (named, ours) {
            (Some(named), Some(ours)) if named != ours => {
                let _ = std::fs::remove_file(path);
                false
            }
            _ => true,
        }
    }

    pub(super) fn cancellation(&self) -> &tokio_util::sync::CancellationToken {
        &self.inner.cancellation
    }

    pub(super) fn check_startup(&self) -> Result<(), BtccError> {
        if self.requested() {
            Err(Self::cancelled_startup())
        } else {
            Ok(())
        }
    }

    pub(super) fn attach_writer(&self, writer: Arc<TranscriptWriter>) {
        let _ = self.inner.writer.set(writer);
    }
}

/// A thread remains responsive even if a startup worker blocks the runtime.
/// Normal shutdown disarms it after runtime close, flush and instance release.
fn exit_after_grace(inner: Arc<Inner>) {
    let spawned = std::thread::Builder::new()
        .name("butler-stop-grace".into())
        .spawn(move || {
            std::thread::sleep(STOP_GRACE);
            if inner.completed.load(Ordering::Acquire) {
                return;
            }
            butler_core::diagnostic!(
                "[native-butler] stop deadline reached; cleaning up before exit"
            );
            super::super::shutdown_trace::event("deadline_cleanup:begin");
            super::super::shutdown_trace::event("deadline_mcp:begin");
            butler_models::mcp_client::stop_mcp_children();
            super::super::shutdown_trace::event("deadline_mcp:end");
            if let Some(writer) = inner.writer.get().cloned() {
                super::super::shutdown_trace::event("deadline_transcript:begin");
                let _ = writer.close_on_deadline(Duration::from_millis(500));
                super::super::shutdown_trace::event("deadline_transcript:end");
            }
            super::super::diagnostics::lifecycle(
                &inner.version,
                "exit",
                "shutdown_deadline",
                "Service reached its shutdown deadline and completed forced cleanup.",
            );
            if let Some((data_root, nonce, installation)) = inner.instance.get() {
                crate::host::service::instance::release_record(data_root, installation, nonce);
            }
            super::super::shutdown_trace::event("deadline_exit");
            std::process::exit(0);
        });
    if spawned.is_err() {
        butler_core::diagnostic!("[native-butler] stop grace timer unavailable");
    }
}
