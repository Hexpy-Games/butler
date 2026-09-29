//! Stop requests and the exit status they produce.
//!
//! The host's stop requests (SIGTERM and SIGINT; console control events on
//! Windows, see `butler_platform::process_control::shutdown_requests`) are
//! listened for from the start of the service, so a stop that arrives while
//! the service is still starting ends it cleanly instead of killing it with
//! the signal. Every other source of a stop (the shutdown flag, the App
//! releasing its lease, and on Windows the control endpoint's `service_stop`
//! command) requests the same [`StopSignal`]. A requested stop exits 0; an exit
//! nobody asked for (a crash, a failure, a turn that needs a new process)
//! exits non-zero. Supervisors depend on it: the App reads the stop intent,
//! and launchd (`KeepAlive: {SuccessfulExit: false}`) and systemd
//! (`Restart=on-failure`) restart only an Agent that exits non-zero.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use butler_platform::process_control::shutdown_requests;
use tokio::sync::watch;

use butler_turn::btcc::BtccError;

use crate::host::service::instance::stop_announced_for;

/// Error code of a startup that a stop request ended.
pub(super) const START_CANCELLED: &str = "native_service_start_cancelled";

/// How long a stop a controller announced (`state/agent-stop-intent.json`)
/// may drain running work before the process exits 0 by itself. Shorter than
/// the controller's SIGKILL deadline (8 s), so an announced stop never ends in
/// a signal death that launchd or systemd would restart.
const ANNOUNCED_STOP_GRACE: Duration = Duration::from_secs(6);

/// Whether a stop was requested: SIGTERM, SIGINT, the shutdown flag or the
/// App releasing its foreground lease.
#[derive(Clone)]
pub(super) struct StopSignal {
    inner: Arc<Inner>,
}

struct Inner {
    requested: watch::Sender<bool>,
    /// DATA and the instance nonce, once the instance record is published.
    instance: OnceLock<(PathBuf, String)>,
}

impl StopSignal {
    /// Starts listening for the host's stop requests (SIGTERM and SIGINT).
    pub(super) fn listen() -> std::io::Result<Self> {
        let mut requests = shutdown_requests()?;
        let stop = Self {
            inner: Arc::new(Inner {
                requested: watch::Sender::new(false),
                instance: OnceLock::new(),
            }),
        };
        let listener = stop.clone();
        tokio::spawn(async move {
            requests.recv().await;
            listener.request_controlled();
        });
        Ok(stop)
    }

    /// Names the published instance, so a signal can be matched to the stop
    /// intent a controller wrote for it.
    pub(super) fn attach(&self, data_root: PathBuf, nonce: &str) {
        let _ = self.inner.instance.set((data_root, nonce.to_owned()));
    }

    /// Records a stop a controller or the host requested (a stop request
    /// from the host, or the control endpoint's `service_stop`). A stop the
    /// controller announced for this instance also ends the process after
    /// [`ANNOUNCED_STOP_GRACE`], before the controller would force it.
    pub(super) fn request_controlled(&self) {
        self.request();
        if self.announced() {
            exit_after_grace();
        }
    }

    /// Records a stop request.
    pub(super) fn request(&self) {
        self.inner.requested.send_replace(true);
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
        let ours = self.inner.instance.get().map(|(_, nonce)| nonce.as_str());
        match (named, ours) {
            (Some(named), Some(ours)) if named != ours => {
                let _ = std::fs::remove_file(path);
                false
            }
            _ => true,
        }
    }

    /// Whether the stop intent on disk names this instance.
    fn announced(&self) -> bool {
        let pid = std::process::id();
        self.inner
            .instance
            .get()
            .is_some_and(|(data_root, nonce)| stop_announced_for(data_root, pid, nonce))
    }
}

/// Ends the process with status 0 once [`ANNOUNCED_STOP_GRACE`] has passed,
/// if it has not exited by then. Only a controller's announced stop arms it:
/// the controller would force-kill the process a little later.
fn exit_after_grace() {
    let spawned = std::thread::Builder::new()
        .name("butler-stop-grace".into())
        .spawn(|| {
            std::thread::sleep(ANNOUNCED_STOP_GRACE);
            eprintln!(
                "[native-butler] announced stop still draining after {}s; exiting",
                ANNOUNCED_STOP_GRACE.as_secs()
            );
            std::process::exit(0);
        });
    if spawned.is_err() {
        eprintln!("[native-butler] stop grace timer unavailable");
    }
}
