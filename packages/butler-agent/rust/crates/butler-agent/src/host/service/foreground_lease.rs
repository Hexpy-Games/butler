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

    /// Resolves once the App has released the lease, after recording the App's exit code (0x… on Windows, `unknown` elsewhere).
    pub(in crate::host) async fn closed(&self) -> Result<(), crate::host::HostError> {
        self.input
            .closed()
            .await
            .map_err(|error| format!("foreground_lease_failed: {error}"))?;
        let code = match &self.app {
            Some(app) => app.code(std::time::Duration::from_secs(2)).await,
            None => None,
        };
        let code = code.map_or_else(|| "unknown".to_owned(), |code| format!("{code:#010x}"));
        butler_core::diagnostic!(
            "[service-lifecycle] event=app_exit code={code} The App released its foreground lease."
        );
        Ok(())
    }
}
