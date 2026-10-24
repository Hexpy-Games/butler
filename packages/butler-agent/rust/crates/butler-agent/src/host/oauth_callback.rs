//! Provider-neutral loopback callback binding, request validation and browser replies.

use std::time::Duration;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

/// Longest callback request head the listener reads.
const MAX_REQUEST_HEAD: usize = 8192;
/// How long one connection may take to send its request head.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
pub(crate) struct CallbackPages {
    pub success: &'static str,
    pub declined: &'static str,
    pub failed: &'static str,
    pub cancelled: &'static str,
    pub not_pending: &'static str,
}
#[derive(Clone, Copy)]
pub(crate) struct CallbackSpec {
    pub path: &'static str,
    pub port_env: &'static str,
    pub pages: CallbackPages,
}
pub(crate) enum CallbackBindError {
    PortInvalid,
    PortUnavailable,
}

pub(crate) async fn bind(
    spec: CallbackSpec,
) -> Result<(tokio::net::TcpListener, String), CallbackBindError> {
    bind_with_environment(
        spec,
        std::env::var(spec.port_env).ok().as_deref(),
        std::env::var("BUTLER_OAUTH_CALLBACK_BIND_HOST")
            .ok()
            .as_deref(),
    )
    .await
}
pub(crate) async fn bind_with_environment(
    spec: CallbackSpec,
    port: Option<&str>,
    host: Option<&str>,
) -> Result<(tokio::net::TcpListener, String), CallbackBindError> {
    let port = port
        .unwrap_or("0")
        .parse::<u16>()
        .map_err(|_| CallbackBindError::PortInvalid)?;
    let host = match host {
        Some(host) => host.to_owned(),
        None => tokio::task::spawn_blocking(|| {
            if std::path::Path::new("/.dockerenv").exists()
                || std::path::Path::new("/run/.containerenv").exists()
            {
                "0.0.0.0"
            } else {
                "127.0.0.1"
            }
            .to_owned()
        })
        .await
        .map_err(|_| CallbackBindError::PortUnavailable)?,
    };
    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .map_err(|_| CallbackBindError::PortUnavailable)?;
    let port = listener
        .local_addr()
        .map_err(|_| CallbackBindError::PortUnavailable)?
        .port();
    Ok((listener, format!("http://127.0.0.1:{port}{}", spec.path)))
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Callback {
    Code {
        code: String,
        params: std::collections::BTreeMap<String, String>,
    },
    Denied {
        error: String,
    },
    Ignored,
}

/// Reads one request within [`READ_TIMEOUT`] and answers it unless it
/// carries this sign-in's code (the caller answers that one).
pub(crate) async fn read_callback(
    stream: &mut TcpStream,
    redirect_uri: &str,
    spec: CallbackSpec,
    state: &str,
) -> Callback {
    let Ok(Ok(Some(target))) =
        tokio::time::timeout(READ_TIMEOUT, read_request_target(stream)).await
    else {
        return Callback::Ignored;
    };
    let Some(current) = url::Url::parse(redirect_uri)
        .ok()
        .and_then(|base| base.join(&target).ok())
        .filter(|url| url.path() == spec.path)
    else {
        respond(stream, 404, "Not found").await;
        return Callback::Ignored;
    };
    let params: std::collections::BTreeMap<_, _> = current.query_pairs().into_owned().collect();
    let callback = classify(&params, state);
    match callback {
        Callback::Code { .. } => {}
        Callback::Denied { .. } => respond(stream, 400, spec.pages.declined).await,
        Callback::Ignored => respond(stream, 400, spec.pages.not_pending).await,
    }
    callback
}

/// The callback its query parameters make for the sign-in with `state`.
fn classify(params: &std::collections::BTreeMap<String, String>, state: &str) -> Callback {
    if params.get("state").map(String::as_str) != Some(state) {
        return Callback::Ignored;
    }
    if params.contains_key("error") {
        return Callback::Denied {
            error: params["error"].clone(),
        };
    }
    params
        .get("code")
        .filter(|code| !code.is_empty())
        .map_or(Callback::Ignored, |code| Callback::Code {
            code: code.clone(),
            params: params.clone(),
        })
}

/// The path and query of a `GET` request, or `None` (answered) for any
/// other request.
async fn read_request_target(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut request = vec![0_u8; MAX_REQUEST_HEAD];
    let mut length = 0;
    loop {
        if length == request.len() {
            respond(stream, 400, "Invalid OAuth callback.").await;
            return Ok(None);
        }
        let count = stream.read(&mut request[length..]).await?;
        if count == 0 {
            return Ok(None);
        }
        length += count;
        if request[..length]
            .windows(4)
            .any(|bytes| bytes == b"\r\n\r\n")
        {
            break;
        }
    }
    let request = String::from_utf8_lossy(&request[..length]);
    let line = request.lines().next().unwrap_or("");
    let target = line.split_whitespace().collect::<Vec<_>>();
    match target.as_slice() {
        ["GET", path, _] if path.starts_with('/') && !path.starts_with("//") => {
            Ok(Some((*path).to_owned()))
        }
        _ => {
            respond(stream, 404, "Not found").await;
            Ok(None)
        }
    }
}

/// Answers the browser with a short plain-text page and closes.
pub(crate) async fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let status_text = reqwest::StatusCode::from_u16(status)
        .ok()
        .and_then(|status| status.canonical_reason())
        .unwrap_or("Unknown");
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // The browser may already be gone; the sign-in outcome does not depend on it.
    let _ = stream.write_all(response.as_bytes()).await;
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn params(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    /// Security boundary: only a callback carrying this sign-in's state (and a
    /// non-empty code or a denial) completes or declines it; every stray variant
    /// is ignored.
    // test-category: security
    #[test]
    fn only_this_sign_ins_state_can_complete_or_decline_it() {
        let state = "s1";
        assert_eq!(
            classify(&params(&[("state", "s1"), ("code", "c")]), state),
            Callback::Code {
                code: "c".into(),
                params: params(&[("state", "s1"), ("code", "c")])
            }
        );
        assert_eq!(
            classify(
                &params(&[("state", "s1"), ("error", "access_denied")]),
                state
            ),
            Callback::Denied {
                error: "access_denied".into()
            }
        );
        for stray in [
            params(&[("state", "other"), ("code", "c")]),
            params(&[("state", "other"), ("error", "access_denied")]),
            params(&[("code", "c")]),
            params(&[("state", "s1")]),
            params(&[("state", "s1"), ("code", "")]),
        ] {
            assert_eq!(classify(&stray, state), Callback::Ignored, "{stray:?}");
        }
    }
}
