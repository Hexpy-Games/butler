//! HTTP transport: the command envelope POSTed as JSON, never redirected.
use super::{Hooks, execute::Finished};
use butler_core::hooks::{HookDefinition, HookEnvelope};
use butler_log::http::{Client, Phase, Purpose, RedirectPolicy};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
/// Response bodies share the command output cap; overflow is an error.
const BODY_CAP: usize = 65_536;
/// Failure text never includes the URL, which may carry the receiver's secret.
#[derive(Debug, thiserror::Error)]
enum Failure {
    #[error("Hook timed out")]
    Timeout,
    #[error("Hook cancelled")]
    Cancelled,
    #[error("Hook endpoint unreachable")]
    Unreachable,
    #[error("Hook endpoint returned HTTP {0}")]
    Status(u16),
    #[error("Hook response exceeds 64 KiB")]
    BodyLimit,
    #[error("Hook response is not UTF-8")]
    Encoding,
    #[error("Hook request failed")]
    Request,
}
/// A 2xx body is a decision; every other result is a failure under `failClosed`.
pub(super) async fn run(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
    cancel: CancellationToken,
) -> Finished {
    let deadline = Duration::from_millis(hook.timeout_ms);
    let result = tokio::select! {
        result = tokio::time::timeout(deadline, post(hooks, hook, payload)) => {
            result.unwrap_or(Err(Failure::Timeout))
        }
        () = cancel.cancelled() => Err(Failure::Cancelled),
        () = hooks.shutdown.cancelled() => Err(Failure::Cancelled),
    };
    let (status, body, failed) = match result {
        Ok((status, body)) if (200..300).contains(&status) => (Some(status), body, None),
        Ok((status, body)) => (Some(status), body, Some(Failure::Status(status))),
        Err(failure) => (None, String::new(), Some(failure)),
    };
    let (outcome, reason) = match &failed {
        None => super::decision::decide(hook, &body),
        Some(failure) => super::decision::failure(
            hook,
            if matches!(failure, Failure::Timeout) {
                "timeout"
            } else {
                "error"
            },
            &failure.to_string(),
        ),
    };
    Finished {
        outcome,
        reason,
        exit_code: None,
        http_status: status,
        stdout: body,
        stderr: failed.map(|f| f.to_string()).unwrap_or_default(),
    }
}
async fn post(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
) -> Result<(u16, String), Failure> {
    let url = hook.url.as_deref().ok_or(Failure::Request)?;
    // Webhook URLs often carry the receiver's secret in a path segment.
    butler_log::register_endpoint(url);
    let body = super::execute::body(hook, payload).map_err(|_| Failure::Request)?;
    let request = client(hooks)
        .await?
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        // Payloads carry full prompts and tool content; never log bodies.
        .phase(Phase::current().sensitive());
    let mut response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            Failure::Timeout
        } else if e.is_connect() {
            Failure::Unreachable
        } else {
            Failure::Request
        }
    })?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Request)? {
        if bytes.len() + chunk.len() > BODY_CAP {
            return Err(Failure::BodyLimit);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        status,
        String::from_utf8(bytes).map_err(|_| Failure::Encoding)?,
    ))
}
/// Built on first use only; TLS roots load off the async workers.
async fn client(hooks: &Hooks) -> Result<Client, Failure> {
    hooks
        .http
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(|| {
                butler_log::http::external(Purpose::new("hooks.http"))
                    .redirect(RedirectPolicy::none())
                    .pool_max_idle_per_host(0)
                    .build()
            })
            .await
            .map_err(|_| Failure::Request)?
            .map_err(|_| Failure::Request)
        })
        .await
        .cloned()
}
