use tokio_util::sync::CancellationToken;

use crate::web_access::service::{WebAccess, WebAccessError};

pub(super) async fn response_bytes(
    access: &WebAccess,
    request: reqwest::RequestBuilder,
    cancellation: &CancellationToken,
) -> Result<(u16, Vec<u8>), WebAccessError> {
    let fetched = access.fetch_request_to_spool(request, cancellation).await?;
    let status = fetched.status;
    let bytes = tokio::task::spawn_blocking(move || fetched.read_all())
        .await
        .map_err(|_| {
            WebAccessError::new(
                "web_access_spool_failed",
                "Search response could not be read.",
            )
        })?
        .map_err(|_| {
            WebAccessError::new(
                "web_access_spool_failed",
                "Search response could not be read.",
            )
        })?;
    Ok((status, bytes))
}
