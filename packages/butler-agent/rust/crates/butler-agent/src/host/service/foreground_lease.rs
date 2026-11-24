//! Electron foreground ownership lease carried by the child's stdin pipe
//! (see `butler_platform::process_control::StdinLease`).

use butler_platform::process_control::{ExitWatch, StdinLease};

pub(in crate::host) struct ForegroundLease {
    input: StdinLease,
    app: Option<ExitWatch>,
}

impl ForegroundLease {
    pub(in crate::host) fn capture() -> Result<Self, crate::host::HostError> {
        let input = StdinLease::capture()
            .map_err(|error| format!("foreground_lease_unavailable: {error}"))?;
        let app = std::env::var("BUTLER_APP_PID")
            .ok()
            .and_then(|pid| pid.parse::<u32>().ok())
            .and_then(|pid| ExitWatch::capture(pid).ok());
        Ok(Self { input, app })
    }

    /// Resolves once the App has released the lease; the App's exit code (Windows) is reported separately once it ends.
    pub(in crate::host) async fn closed(&self) -> Result<(), crate::host::HostError> {
        self.input
            .closed()
            .await
            .map_err(|error| format!("foreground_lease_failed: {error}"))?;
        match self.app.clone() {
            // A crashed or killed App has already ended; a cleanly quitting one waits for this Agent,
            // so the report never delays the stop (it is dropped if the Agent exits first).
            Some(app) => {
                tokio::spawn(async move {
                    if let Some(code) = app.code(std::time::Duration::from_secs(5)).await {
                        butler_core::diagnostic!(
                            "[service-lifecycle] event=app_exit code={code:#010x} The App ended."
                        );
                    }
                });
            }
            None => butler_core::diagnostic!(
                "[service-lifecycle] event=app_exit code=unknown The App released its foreground lease."
            ),
        }
        Ok(())
    }
}
