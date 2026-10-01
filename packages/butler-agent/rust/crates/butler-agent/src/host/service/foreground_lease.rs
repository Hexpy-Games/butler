//! Electron foreground ownership lease carried by the child's stdin pipe
//! (see `butler_platform::process_control::StdinLease`).

use butler_platform::process_control::StdinLease;

pub(in crate::host) struct ForegroundLease {
    input: StdinLease,
}

impl ForegroundLease {
    pub(in crate::host) fn capture() -> Result<Self, crate::host::HostError> {
        let input = StdinLease::capture()
            .map_err(|error| format!("foreground_lease_unavailable: {error}"))?;
        Ok(Self { input })
    }

    /// Resolves once the App has released the lease.
    pub(in crate::host) async fn closed(&self) -> Result<(), crate::host::HostError> {
        self.input
            .closed()
            .await
            .map_err(|error| format!("foreground_lease_failed: {error}").into())
    }
}
