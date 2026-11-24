use std::{sync::Arc, time::Duration};

use butler_log::http::{Connection, ConnectionStream, Purpose};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::{Instant, MissedTickBehavior},
};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, client_async_tls_with_config,
    tungstenite::{
        Error, Message,
        client::IntoClientRequest,
        http::{HeaderValue, header},
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::{HttpError, HttpState, TunnelState, frames, streams::Streams};
use crate::gateway::{TunnelAccount, crypto};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(60);
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
type Socket = WebSocketStream<MaybeTlsStream<ConnectionStream>>;
type FirstAttempt = oneshot::Sender<Result<(), HttpError>>;

#[derive(Clone, Copy)]
pub(super) enum Stop {
    SignedOut,
    Unauthorized,
    NotInPlan,
    NotFound,
    Replaced,
    Revoked,
}

impl Stop {
    pub(super) fn keeps_id(self) -> bool {
        matches!(self, Self::Replaced | Self::NotInPlan)
    }

    pub(super) fn code(self) -> &'static str {
        match self {
            Self::SignedOut => "butler_account_signed_out",
            Self::Unauthorized => "unauthorized",
            Self::NotInPlan => "tunnel_not_in_plan",
            Self::NotFound => "tunnel_not_found",
            Self::Replaced => "replaced",
            Self::Revoked => "revoked",
        }
    }

    pub(super) fn error(self) -> HttpError {
        let (status, message) = match self {
            Self::SignedOut => (401, "Sign in to your Butler account first."),
            Self::Unauthorized => (401, "Sign in to your Butler account again."),
            Self::NotInPlan => (403, "The Butler account plan does not include the tunnel."),
            Self::NotFound => (404, "Tunnel not found."),
            Self::Replaced => (409, "Another desktop took over the tunnel."),
            Self::Revoked => (403, "The tunnel was revoked."),
        };
        HttpError::public(status, self.code(), message)
    }
}

enum SessionEnd {
    Cancelled,
    Reconnect,
    Failed,
    Stop(Stop),
}

pub(super) async fn run(
    state: Arc<HttpState>,
    session: CancellationToken,
    id: String,
    key: Zeroizing<[u8; 32]>,
    mut first: Option<FirstAttempt>,
) {
    let Some(tunnel) = &state.tunnel else { return };
    let key = Arc::new(key);
    let mut wake = butler_platform::system_wake::wake_events();
    let mut backoff = INITIAL_BACKOFF;
    let tls = tokio::task::spawn_blocking(tls_connector)
        .await
        .ok()
        .and_then(Result::ok);
    let stopped = loop {
        tunnel.transition(&session, TunnelState::Connecting);
        let account = tokio::select! {
            biased;
            () = session.cancelled() => break None,
            account = tunnel.port.account() => account,
        };
        let connected = match account {
            Ok(Some(account)) => tokio::select! {
                biased;
                () = session.cancelled() => break None,
                result = wake.changed() => {
                    if result.is_ok() {
                        settle(&mut first, Ok(()));
                        continue;
                    }
                    break None;
                }
                result = tokio::time::timeout(CONNECT_TIMEOUT, connect(&account, tls.as_ref())) => result.unwrap_or(Ok(None)),
            },
            Ok(None) => break Some(Stop::SignedOut),
            Err(_) => Ok(None),
        };
        if let Err(stop) = connected {
            break Some(stop);
        }
        if let Ok(Some(socket)) = connected {
            let opened = Instant::now();
            tunnel.transition(&session, TunnelState::Connected);
            settle(&mut first, Ok(()));
            let result = serve(socket, &state, &session, &mut wake, &id, key.clone()).await;
            let healthy = opened.elapsed() >= PING_INTERVAL;
            if healthy {
                backoff = INITIAL_BACKOFF;
            }
            match result {
                SessionEnd::Cancelled => break None,
                SessionEnd::Stop(stop) => break Some(stop),
                SessionEnd::Reconnect => continue,
                SessionEnd::Failed if healthy => continue,
                SessionEnd::Failed => (),
            }
            tunnel.transition(&session, TunnelState::Connecting);
        } else {
            settle(&mut first, Ok(()));
        }
        let [jitter, ..] = crypto::random_bytes();
        let delay = backoff.mul_f64(0.8 + f64::from(jitter) * 0.4 / 255.0);
        tokio::select! {
            biased;
            () = session.cancelled() => break None,
            _ = wake.changed() => (),
            () = tokio::time::sleep(delay) => backoff = (backoff * 2).min(MAX_BACKOFF),
        }
    };
    if let Some(stop) = stopped {
        let _change = tunnel.changes.lock().await;
        if !session.is_cancelled() {
            let result = tunnel.stop(&state, stop).await.and(Err(stop.error()));
            settle(&mut first, result);
        }
    } else {
        tracing::info!(reason = "cancelled", "Tunnel stopped");
    }
}

fn settle(first: &mut Option<FirstAttempt>, result: Result<(), HttpError>) {
    if let Some(first) = first.take() {
        let _ = first.send(result);
    }
}

fn tls_connector() -> Result<Connector, std::io::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    let provider = rustls::crypto::ring::default_provider();
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(std::io::Error::other)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

async fn connect(account: &TunnelAccount, tls: Option<&Connector>) -> Result<Option<Socket>, Stop> {
    async fn attempt(account: &TunnelAccount, tls: Option<&Connector>) -> Result<Socket, Error> {
        let invalid_url = || std::io::Error::from(std::io::ErrorKind::InvalidInput);
        let url = format!("{}/v1/tunnel/connect", account.base_url);
        let mut url = url::Url::parse(&url).map_err(|_| invalid_url())?;
        let scheme = match url.scheme() {
            "https" => "wss",
            "http" => "ws",
            _ => return Err(invalid_url().into()),
        };
        url.set_scheme(scheme).map_err(|()| invalid_url())?;
        let host = url.host_str().ok_or_else(invalid_url)?;
        let port = url.port_or_known_default().ok_or_else(invalid_url)?;
        let mut request = url.as_str().into_client_request()?;
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", &*account.device_token))
            .map_err(|_| invalid_url())?;
        auth.set_sensitive(true);
        request.headers_mut().insert(header::AUTHORIZATION, auth);
        let connection = Connection::new(host, port, &Purpose::new("butler-cloud.tunnel"));
        let addresses: Vec<_> = tokio::net::lookup_host((host.trim_matches(['[', ']']), port))
            .await?
            .collect();
        let stream = connection.connect(&addresses, CONNECT_TIMEOUT).await?;
        let limit = Some(frames::HEADER + frames::MAX_PAYLOAD);
        let config = WebSocketConfig::default()
            .max_message_size(limit)
            .max_frame_size(limit);
        let tls = if scheme == "wss" {
            Some(
                tls.cloned()
                    .ok_or_else(|| std::io::Error::other("TLS connector unavailable"))?,
            )
        } else {
            None
        };
        let upgraded = client_async_tls_with_config(request, stream, Some(config), tls).await;
        let outcome = upgraded
            .as_ref()
            .map(|_| ())
            .map_err(|_| std::io::Error::other("upgrade failed"));
        connection.finish(outcome);
        upgraded.map(|(socket, _)| socket)
    }

    let stop = match attempt(account, tls).await {
        Ok(socket) => return Ok(Some(socket)),
        Err(Error::Http(response)) => match response.status().as_u16() {
            401 => Some(Stop::Unauthorized),
            403 => Some(Stop::NotInPlan),
            404 => Some(Stop::NotFound),
            _ => None,
        },
        Err(_) => None,
    };
    stop.map_or(Ok(None), Err)
}

async fn serve(
    mut socket: Socket,
    state: &Arc<HttpState>,
    session: &CancellationToken,
    wake: &mut watch::Receiver<u64>,
    id: &str,
    key: Arc<Zeroizing<[u8; 32]>>,
) -> SessionEnd {
    let (sender, mut outgoing) = mpsc::channel(64);
    let mut streams = Streams::new(state, session.child_token(), id, key, sender);
    let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut pong = true;
    let mut ping_due = false;
    let end = 'session: loop {
        let send = if ping_due {
            ping_due = false;
            pong = false;
            Some(Message::Text("ping".into()))
        } else {
            tokio::select! {
                () = session.cancelled() => break SessionEnd::Cancelled,
                _ = wake.changed() => break SessionEnd::Reconnect,
                _ = ping.tick() => {
                    if !pong { break SessionEnd::Reconnect; }
                    pong = false;
                    Some(Message::Text("ping".into()))
                }
                item = outgoing.recv() => item.filter(|message| streams.outgoing(message)),
                item = socket.next() => match item {
                    Some(Ok(Message::Binary(bytes))) => {
                        let Some(frame) = frames::Frame::parse(bytes) else { break SessionEnd::Failed };
                        streams.receive(frame)
                    }
                    Some(Ok(Message::Text(text))) if text.as_str() == "pong" => {
                        pong = true;
                        None
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => None,
                    Some(Ok(Message::Close(Some(close)))) => break match u16::from(close.code) {
                        4001 => SessionEnd::Stop(Stop::Replaced),
                        4003 => SessionEnd::Stop(Stop::Revoked),
                        _ => SessionEnd::Failed,
                    },
                    _ => break SessionEnd::Failed,
                }
            }
        };
        if let Some(message) = send {
            let send = socket.send(message);
            tokio::pin!(send);
            loop {
                tokio::select! {
                    () = session.cancelled() => break 'session SessionEnd::Cancelled,
                    _ = wake.changed() => break 'session SessionEnd::Reconnect,
                    _ = ping.tick() => {
                        if ping_due || !pong { break 'session SessionEnd::Reconnect; }
                        ping_due = true;
                    }
                    result = &mut send => {
                        if result.is_err() { break 'session SessionEnd::Failed; }
                        break;
                    }
                }
            }
        }
    };
    drop(streams);
    if matches!(end, SessionEnd::Cancelled) {
        let _ = socket
            .close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "".into(),
            }))
            .await;
    }
    end
}
