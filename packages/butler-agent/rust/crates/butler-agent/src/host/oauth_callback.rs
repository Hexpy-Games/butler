//! The localhost OAuth callback of the ChatGPT (Codex subscription) sign-in:
//! where the callback listens, and how one browser request to it is read
//! and answered. Shared by `butler auth login` and the App's first-run
//! sign-in flow.

use std::time::Duration;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

/// Longest callback request head the listener reads.
const MAX_REQUEST_HEAD: usize = 8192;
/// How long one connection may take to send its request head.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

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

/// What one request to the callback listener was.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Callback {
    /// The authorization code of this sign-in.
    Code(String),
    /// This sign-in's state with an `error`: the user declined.
    Denied,
    /// Anything else (another path or state, no code, not a `GET`, an
    /// unreadable or idle connection); already answered or dropped. It
    /// never ends the sign-in: any local page can reach the listener.
    Ignored,
}

/// Reads one request within [`READ_TIMEOUT`] and answers it unless it
/// carries this sign-in's code (the caller answers that one).
pub(crate) async fn read_callback(
    stream: &mut TcpStream,
    redirect_uri: &str,
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
        .filter(|url| url.path() == "/auth/callback")
    else {
        respond(stream, 404, "Not found").await;
        return Callback::Ignored;
    };
    let params: std::collections::HashMap<_, _> = current.query_pairs().into_owned().collect();
    let callback = classify(&params, state);
    match callback {
        Callback::Code(_) => {}
        Callback::Denied => respond(stream, 400, "Codex subscription login was declined.").await,
        Callback::Ignored => respond(stream, 400, "This is not the pending sign-in.").await,
    }
    callback
}

/// The callback its query parameters make for the sign-in with `state`.
fn classify(params: &std::collections::HashMap<String, String>, state: &str) -> Callback {
    if params.get("state").map(String::as_str) != Some(state) {
        return Callback::Ignored;
    }
    if params.contains_key("error") {
        return Callback::Denied;
    }
    params
        .get("code")
        .filter(|code| !code.is_empty())
        .map_or(Callback::Ignored, |code| Callback::Code(code.clone()))
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn only_this_sign_ins_state_can_complete_or_decline_it() {
        let state = "s1";
        assert_eq!(
            classify(&params(&[("state", "s1"), ("code", "c")]), state),
            Callback::Code("c".into())
        );
        assert_eq!(
            classify(
                &params(&[("state", "s1"), ("error", "access_denied")]),
                state
            ),
            Callback::Denied
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
