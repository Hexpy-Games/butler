use tokio_util::sync::CancellationToken;

pub(in crate::host) fn signals(
    token: CancellationToken,
) -> Result<tokio::task::JoinHandle<()>, crate::host::HostError> {
    let mut requests = butler_platform::process_control::shutdown_requests()
        .map_err(crate::host::HostError::from_error)?;
    Ok(tokio::spawn(async move {
        requests.recv().await;
        token.cancel();
    }))
}
