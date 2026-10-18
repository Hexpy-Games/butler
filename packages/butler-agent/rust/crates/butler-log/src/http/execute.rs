use super::{Error, Phase, Purpose, observe, redirect};
use reqwest::{Client, Request, Response};
use std::time::Instant;

pub(super) async fn chain(
    client: Client,
    mut request: Request,
    policy: redirect::Policy,
    purpose: Purpose,
    mut phase: Phase,
    timeout: Option<std::time::Duration>,
) -> Result<Response, Error> {
    super::logging::ensure().await;
    let start = Instant::now();
    let timeout = request.timeout().copied().or(timeout);
    let mut previous = Vec::new();
    let mut replays = 0;
    loop {
        if let Some(timeout) = timeout {
            *request.timeout_mut() =
                Some(timeout.checked_sub(start.elapsed()).ok_or(Error::Timeout)?);
        }
        previous.push(request.url().clone());
        let next = request.try_clone();
        let response = match attempt(&client, request, &purpose, &phase).await {
            Err(Error::Transport(error))
                if replays < 2 && super::retry::safe(&error) && next.is_some() =>
            {
                previous.pop();
                request = next.ok_or(Error::Timeout)?;
                replays += 1;
                phase.retry += 1;
                continue;
            }
            result => result?,
        };
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
        row.level = if phase.routine { "DEBUG" } else { "WARN" }.into();
        row.event = "http.retry".into();
        crate::emit(row);
    }
    let response = match client.execute(request).await {
        Ok(response) => response,
        Err(error) => {
            attempt.row.level = if phase.routine { "DEBUG" } else { "ERROR" }.into();
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
async fn error_prefix(response: Response) -> Result<Response, Error> {
    use http_body_util::BodyExt;
    let (parts, mut body) = super::response::split(response);
    let mut prefix = std::collections::VecDeque::new();
    let mut size = 0;
    while size < 4096 {
        match body.frame().await {
            Some(Ok(frame)) => {
                size += frame.data_ref().map_or(0, bytes::Bytes::len);
                prefix.push_back(Ok(frame));
            }
            Some(Err(error)) => {
                prefix.push_back(Err(error));
                break;
            }
            None => break,
        }
    }
    Ok(::http::Response::from_parts(
        parts,
        reqwest::Body::wrap(super::body::Replay {
            inner: body,
            prefix,
        }),
    )
    .into())
}
