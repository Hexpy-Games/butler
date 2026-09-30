//! A foreground agent must also finish startup or release its reserved port.

use std::{future::Future, time::Duration};

use butler_turn::btcc::BtccError;
use tokio::sync::oneshot;

use super::stop_signal::StopSignal;

/// Matches the CLI startup deadline; it never limits a running service.
pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

pub(super) async fn until_ready(
    service: impl Future<Output = Result<String, BtccError>>,
    ready: oneshot::Receiver<()>,
    stop: &StopSignal,
) -> Result<String, BtccError> {
    tokio::pin!(service);
    let startup = async {
        tokio::select! {
            initialized = tokio::time::timeout(STARTUP_TIMEOUT, ready) => {
                match initialized {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(_)) => Err(BtccError::relayed(
                        "native_service_start_failed", "Startup ended before readiness",
                    )),
                    Err(_) => Err(BtccError::relayed(
                        "native_service_start_timeout", "Startup did not finish within 90 seconds",
                    )),
                }
            }
            () = stop.wait() => Err(StopSignal::cancelled_startup()),
        }
    };
    tokio::select! {
        // Preserve the actual failure when startup drops its readiness sender.
        biased;
        result = &mut service => result,
        initialized = startup => {
            initialized?;
            service.await
        }
    }
}
