//! Forward browser callbacks over the computer's pinned SSH connection.
use super::{
    AppSetupPort, Computer, HttpError, connect, deploy::RemoteState, locked, relay, remote_error,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time,
};
use tokio_util::sync::CancellationToken;

static FORWARDS: LazyLock<Mutex<HashMap<String, (String, CancellationToken)>>> =
    LazyLock::new(Mutex::default);

pub(super) fn replace(id: &str, flow_id: &str, shutdown: &CancellationToken) -> CancellationToken {
    let token = shutdown.child_token();
    if let Some((_, previous)) = FORWARDS
        .lock()
        .insert(id.to_owned(), (flow_id.to_owned(), token.clone()))
    {
        previous.cancel();
    }
    token
}

pub(super) fn stop(id: &str, flow_id: &str) {
    let mut forwards = FORWARDS.lock();
    if let std::collections::hash_map::Entry::Occupied(entry) = forwards.entry(id.to_owned())
        && entry.get().0 == flow_id
    {
        entry.remove().1.cancel();
    }
}

pub(super) async fn serve(
    listener: TcpListener,
    computer: Computer,
    callback: Callback,
    stop: CancellationToken,
) {
    let connections = async {
        while let Ok((mut stream, _)) = listener.accept().await {
            let read = async {
                let mut buffer = [0_u8; 8192];
                let mut len = 0;
                while len < buffer.len() {
                    let n = stream.read(&mut buffer[len..]).await.ok()?;
                    if n == 0 {
                        break;
                    }
                    let from = len.saturating_sub(3);
                    len += n;
                    if let Some(end) = buffer[from..len].windows(4).position(|w| w == b"\r\n\r\n") {
                        return Some(buffer[..from + end + 4].to_vec());
                    }
                }
                None
            };
            let Ok(Some(head)) = time::timeout(Duration::from_secs(10), read).await else {
                continue;
            };
            let reply = relay::loopback(&computer, callback, head, stop.clone())
                .await
                .unwrap_or_else(|_| "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n".into());
            let _ = stream.write_all(reply.as_bytes()).await;
            let _ = stream.shutdown().await;
            if reply.starts_with("HTTP/1.1 200") {
                break;
            }
        }
    };
    tokio::select! {
        biased;
        () = stop.cancelled() => {},
        () = time::sleep(Duration::from_secs(330)) => {},
        () = connections => {},
    }
}

#[derive(Clone, Copy)]
pub(super) enum Callback {
    Port(u16),
    Socket,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(in crate::gateway) struct OauthStart {
    #[serde(default)]
    kind: Option<Value>,
}

pub(in crate::gateway) async fn oauth_start(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    id: &str,
    version: &str,
    input: OauthStart,
    shutdown: CancellationToken,
) -> Result<Value, HttpError> {
    let (_lock, computer) = locked(root, id).await?;
    let (state, _) = connect(setup, root, version, &computer, shutdown.clone()).await?;
    let callback_socket = use_callback_socket(&state, version);
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| HttpError::Internal)?;
    let port = listener
        .local_addr()
        .map_err(|_| HttpError::Internal)?
        .port();
    let mut body = json!({"force":true,"redirect_port":port});
    if callback_socket {
        body["callback_socket"] = json!(true);
    }
    if let Some(kind) = input.kind {
        body["kind"] = kind;
    }
    let view = relay::data(
        relay::request(
            &computer,
            "POST",
            "/setup/oauth/start",
            body.to_string().into_bytes(),
            shutdown.clone(),
        )
        .await?,
    )?;
    if view["status"] != "pending" {
        return Ok(view);
    }
    let invalid = || {
        remote_error(
            "remote_oauth_invalid",
            "This computer returned an invalid sign-in.",
        )
    };
    let callback = if callback_socket {
        if view["callback_socket"] != true {
            return Err(invalid());
        }
        Callback::Socket
    } else {
        Callback::Port(
            view["callback_port"]
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .ok_or_else(invalid)?,
        )
    };
    let flow_id = view["flow_id"].as_str().ok_or_else(invalid)?;
    let stop = replace(id, flow_id, &shutdown);
    tokio::spawn(serve(listener, computer, callback, stop));
    Ok(view)
}

fn use_callback_socket(state: &RemoteState, version: &str) -> bool {
    state.version == version
}

#[cfg(test)]
mod tests {
    use super::*;

    // test-category: pure-logic
    #[test]
    fn oauth_callback_socket_requires_matching_versions() {
        let state = RemoteState {
            version: "1.2.3".into(),
            started: false,
        };
        assert!(use_callback_socket(&state, "1.2.3"));
        assert!(!use_callback_socket(&state, "1.2.4"));
    }
}
