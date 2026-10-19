use butler_turn::btcc::BtccError;
use std::time::Duration;
pub(in crate::host) async fn hold_dispatch_readiness(
    data_root: &std::path::Path,
) -> Result<(), BtccError> {
    hold_ingress_barrier(
        data_root,
        "BUTLER_E2E_HOLD_DISPATCH_READY",
        "e2e-dispatch-ready-held",
        "e2e-dispatch-ready-release",
    )
    .await
}

pub(in crate::host) async fn hold_queue_claims(
    data_root: &std::path::Path,
) -> Result<(), BtccError> {
    hold_ingress_barrier(
        data_root,
        "BUTLER_E2E_HOLD_QUEUE_CLAIMS",
        "e2e-queue-claims-held",
        "e2e-queue-claims-release",
    )
    .await?;
    match tokio::fs::remove_file(data_root.join("e2e-queue-claims-held")).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(BtccError::relayed(
            "e2e_dispatch_ready_hold_failed",
            error.to_string(),
        )),
    }
}

async fn hold_ingress_barrier(
    data_root: &std::path::Path,
    switch: &str,
    held: &str,
    release: &str,
) -> Result<(), BtccError> {
    if std::env::var(switch).as_deref() != Ok("1") {
        return Ok(());
    }
    let held = data_root.join(held);
    let release = data_root.join(release);
    tokio::fs::write(held, b"held")
        .await
        .map_err(|error| BtccError::relayed("e2e_dispatch_ready_hold_failed", error.to_string()))?;
    while !tokio::fs::try_exists(&release)
        .await
        .map_err(|error| BtccError::relayed("e2e_dispatch_ready_hold_failed", error.to_string()))?
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

pub(in crate::host) async fn injected_service_failure(
    data_root: &std::path::Path,
) -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_FORCE_SERVICE_EXIT").as_deref() == Ok("1")
        && tokio::fs::remove_file(data_root.join("e2e-service-exit"))
            .await
            .is_ok()
    {
        return Err(BtccError::relayed(
            "native_service_replacement_required",
            "Injected unrecoverable service failure",
        ));
    }
    Ok(())
}

pub(in crate::host) fn stop_delay() -> Option<Duration> {
    let ms = std::env::var("BUTLER_E2E_RESET_STOP_DELAY_MS")
        .ok()?
        .parse::<u64>()
        .ok()?;
    Some(Duration::from_millis(ms.min(30_000)))
}

pub(in crate::host) fn watch_paths(root: &std::path::Path, paths: &mut Vec<std::path::PathBuf>) {
    paths.push(root.join("e2e-service-exit"));
}
