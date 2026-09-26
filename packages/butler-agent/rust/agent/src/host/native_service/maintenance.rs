//! Periodic service upkeep beside the inbound queue: progress reconciliation
//! and parent-result delivery to the active App endpoint.

use std::sync::Arc;
use std::time::Duration;

use tokio::{sync::oneshot, time::MissedTickBehavior};

use super::support::{deliver_parent_results, failure};
use crate::btcc::BtccError;
use crate::host::NativeProgressPublisher;
use crate::host::gateway_lifecycle::NativeActiveAppEndpoint;

const SERVICE_MAINTENANCE_INTERVAL: Duration = Duration::from_millis(500);

pub(super) async fn run_service_maintenance(
    progress: Arc<NativeProgressPublisher>,
    parent_client: reqwest::Client,
    subsessions: crate::btcc::SqliteSubsessionRepository,
    app_endpoint: NativeActiveAppEndpoint,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), BtccError> {
    let mut interval = tokio::time::interval(SERVICE_MAINTENANCE_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => return Ok(()),
            _ = interval.tick() => {},
        }
        let pass = async {
            progress.reconcile().await?;
            if let Some(active) = app_endpoint.snapshot() {
                deliver_parent_results(
                    &parent_client,
                    &subsessions,
                    &active.base_url,
                    &active.local_auth,
                )
                .await?;
            }
            Ok::<(), BtccError>(())
        };
        tokio::select! {
            biased;
            _ = &mut stop => return Ok(()),
            result = pass => result?,
        }
    }
}

pub(super) fn maintenance_join_result(
    joined: Result<Result<(), BtccError>, tokio::task::JoinError>,
) -> Result<(), BtccError> {
    match joined {
        Ok(result) => result,
        Err(_) => Err(failure(
            "native_service_maintenance_failed",
            "Native service maintenance task failed",
        )),
    }
}

pub(super) fn unexpected_maintenance_exit(
    joined: Option<Result<Result<(), BtccError>, tokio::task::JoinError>>,
) -> Result<(), BtccError> {
    match joined {
        Some(Ok(Err(error))) => Err(error),
        Some(Err(_)) => Err(failure(
            "native_service_maintenance_failed",
            "Native service maintenance task failed",
        )),
        Some(Ok(Ok(()))) | None => Err(failure(
            "native_service_maintenance_stopped",
            "Native service maintenance stopped unexpectedly",
        )),
    }
}
