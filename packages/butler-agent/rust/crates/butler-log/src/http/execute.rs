use super::{Error, Phase, Purpose, observe, redirect};
use reqwest::{Client, Request, Response};
use std::time::Instant;

pub(super) async fn chain(
    client: Client,
    mut request: Request,
    policy: redirect::Policy,
    purpose: Purpose,
    phase: Phase,
    timeout: Option<std::time::Duration>,
) -> Result<Response, Error> {
    super::logging::ensure().await.map_err(Error::Logging)?;
    let start = Instant::now();
    let timeout = request.timeout().copied().or(timeout);
    let mut previous = Vec::new();
    loop {
        if let Some(timeout) = timeout {
            *request.timeout_mut() =
                Some(timeout.checked_sub(start.elapsed()).ok_or(Error::Timeout)?);
        }
        previous.push(request.url().clone());
        let next = request.try_clone();
        let response = attempt(&client, request, &purpose, &phase).await?;
        let Some(next) = policy.next(&response, next, &previous)? else {
            return Ok(response);
        };
        drop(response);
        request = next;
    }
}
async fn attempt(
    client: &Client,
    mut request: Request,
    purpose: &Purpose,
    phase: &Phase,
) -> Result<Response, Error> {
    request.headers_mut().remove("traceparent");
    request.headers_mut().remove("tracestate");
    super::register_credentials(&request);
    let mut attempt = observe::Attempt::new(&mut request, purpose, phase);
    if phase.retry > 0 {
        let mut row = attempt.row.clone();
        row.level = "WARN".into();
        row.event = "http.retry".into();
        crate::emit(row);
    }
    let response = match client.execute(request).await {
        Ok(response) => response,
        Err(error) => {
            attempt.row.level = "ERROR".into();
            attempt.row.error = Some(serde_json::json!({"message":error.to_string()}));
            return Err(error.into());
        }
    };
    attempt.headers(&response);
    let error = response.status().is_client_error() || response.status().is_server_error();
    let response = attempt.wrap(response);
    if error && observe::detailed() {
        error_prefix(response).await
    } else {
        Ok(response)
    }
}
/// Error callers often discard the body. Read a bounded prefix, then replay
/// those exact chunks, preserving the original body stream and backpressure.
async fn error_prefix(mut response: Response) -> Result<Response, Error> {
    use futures_util::StreamExt;
    use http_body_util::BodyExt;
    let mut prefix = Vec::new();
    let mut size = 0;
    while size < 4096 {
        let Some(chunk) = response.chunk().await? else {
            break;
        };
        size += chunk.len();
        prefix.push(Ok::<_, reqwest::Error>(chunk));
    }
    let (parts, body) = super::response::split(response);
    let stream = futures_util::stream::iter(prefix).chain(body.into_data_stream());
    Ok(::http::Response::from_parts(parts, reqwest::Body::wrap_stream(stream)).into())
}
