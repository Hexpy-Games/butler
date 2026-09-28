//! The localhost OAuth callback of the ChatGPT (Codex subscription) sign-in:
//! where the callback listens, and how one browser request to it is read
//! and answered. Shared by `butler auth login` and the App's first-run
//! sign-in flow.

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

/// Longest callback request head the listener reads.
const MAX_REQUEST_HEAD: usize = 8192;

/// Where the callback listens and what the provider redirects to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CallbackEndpoint {
    pub(crate) bind_host: String,
    /// `localhost` unless overridden; `0.0.0.0` inside a container.
    pub(crate) listen_host: String,
    pub(crate) port: u16,
    pub(crate) redirect_uri: String,
}

impl CallbackEndpoint {
    /// The endpoint from `BUTLER_CODEX_OAUTH_*` (or `BUTLER_OPENAI_OAUTH_*`):
    /// port 1455 and `http://localhost:{port}/auth/callback` by default.
    pub(crate) fn from_environment() -> Result<Self, std::num::ParseIntError> {
        let port = first_env(&["BUTLER_CODEX_OAUTH_PORT", "BUTLER_OPENAI_OAUTH_PORT"])
            .unwrap_or_else(|| "1455".into())
            .parse::<u16>()?;
        let redirect_uri = first_env(&[
            "BUTLER_CODEX_OAUTH_REDIRECT_URI",
            "BUTLER_OPENAI_OAUTH_REDIRECT_URI",
        ])
        .unwrap_or_else(|| format!("http://localhost:{port}/auth/callback"));
        let listen_host = first_env(&[
            "BUTLER_CODEX_OAUTH_LISTEN_HOST",
            "BUTLER_OPENAI_OAUTH_LISTEN_HOST",
        ])
        .unwrap_or_else(|| {
            if std::path::Path::new("/.dockerenv").exists()
                || std::path::Path::new("/run/.containerenv").exists()
            {
                "0.0.0.0".into()
            } else {
                "localhost".into()
            }
        });
        let bind_host = if listen_host == "localhost" {
            "127.0.0.1".to_owned()
        } else {
            listen_host.clone()
        };
        Ok(Self {
            bind_host,
            listen_host,
            port,
            redirect_uri,
        })
    }
}

/// Why a callback request ended the sign-in. `Display` is the user text.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CallbackError {
    #[error("OAuth authorization denied")]
    Denied,
    #[error("OAuth state mismatch")]
    StateMismatch,
    #[error("OAuth callback did not include a code")]
    MissingCode,
    #[error("OAuth callback could not be read: {0}")]
    Io(#[from] std::io::Error),
}

impl CallbackError {
    /// Stable code for flow views.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Denied => "oauth_denied",
            Self::StateMismatch => "oauth_state_mismatch",
            Self::MissingCode => "oauth_code_missing",
            Self::Io(_) => "oauth_callback_unreadable",
        }
    }
}

/// Reads one request. `Ok(Some(code))` is the authorization code of this
/// sign-in; `Ok(None)` is an unrelated request (already answered);
/// an error ends the sign-in (the browser is told it failed).
pub(crate) async fn read_callback(
    stream: &mut TcpStream,
    redirect_uri: &str,
    state: &str,
) -> Result<Option<String>, CallbackError> {
    let Some(target) = read_request_target(stream).await? else {
        return Ok(None);
    };
    let Some(current) = url::Url::parse(redirect_uri)
        .ok()
        .and_then(|base| base.join(&target).ok())
        .filter(|url| url.path() == "/auth/callback")
    else {
        respond(stream, 404, "Not found").await;
        return Ok(None);
    };
    let params: std::collections::HashMap<_, _> = current.query_pairs().into_owned().collect();
    let failure = if params.contains_key("error") {
        Some(CallbackError::Denied)
    } else if params.get("state").map(String::as_str) != Some(state) {
        Some(CallbackError::StateMismatch)
    } else if params.get("code").is_none_or(String::is_empty) {
        Some(CallbackError::MissingCode)
    } else {
        None
    };
    if let Some(error) = failure {
        respond(stream, 500, "Codex subscription login failed.").await;
        return Err(error);
    }
    Ok(params.get("code").cloned())
}

/// The path and query of a `GET` request, or `None` (answered) for any
/// other request.
async fn read_request_target(stream: &mut TcpStream) -> Result<Option<String>, CallbackError> {
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
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // The browser may already be gone; the sign-in outcome does not depend on it.
    let _ = stream.write_all(response.as_bytes()).await;
}

fn first_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}
