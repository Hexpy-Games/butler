//! Periodic service upkeep beside the inbound queue: progress reconciliation
//! and parent-result delivery to the active App endpoint.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;

use super::support::{deliver_parent_results, failure};
use crate::host::ProgressPublisher;
use crate::host::app::gateway_lifecycle::ActiveAppEndpoint;
use butler_turn::btcc::BtccError;

const SERVICE_MAINTENANCE_INTERVAL: Duration = Duration::from_millis(500);

pub(super) async fn run_service_maintenance(
    progress: Arc<ProgressPublisher>,
    parent_client: reqwest::Client,
    subsessions: butler_turn::btcc::SqliteSubsessionRepository,
    app_endpoint: ActiveAppEndpoint,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), BtccError> {
    let mut storage_changes = progress.subscribe_changes();
    let mut endpoint_changes = app_endpoint.subscribe_changes();
    loop {
        storage_changes.borrow_and_update();
        endpoint_changes.borrow_and_update();
        let pass = async {
            let summary = progress.reconcile().await?;
            let mut retry_pending = summary.attempted > summary.published;
            if let Some(active) = app_endpoint.snapshot() {
                retry_pending |= deliver_parent_results(
                    &parent_client,
                    &subsessions,
                    &active.base_url,
                    &active.local_auth,
                )
                .await?;
            }
            Ok::<bool, BtccError>(retry_pending)
        };
        let retry_pending = tokio::select! {
            biased;
            _ = &mut stop => return Ok(()),
            result = pass => result?,
        };
        tokio::select! {
            biased;
            _ = &mut stop => return Ok(()),
            _ = storage_changes.changed() => {},
            _ = endpoint_changes.changed() => {},
            () = tokio::time::sleep(SERVICE_MAINTENANCE_INTERVAL), if retry_pending => {},
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
