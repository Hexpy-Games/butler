mod frames;
mod noise;
mod socket;
mod streams;

#[cfg(feature = "test-support")]
mod fixture;
#[cfg(feature = "test-support")]
pub use fixture::{FixtureOutput, FixtureResponder};
pub use noise::new_tunnel_key;

use std::sync::Arc;

use axum::{body::Body, http::Request, response::Response};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use super::{HttpError, HttpState};
use crate::gateway::{GatewayTunnelPort, butler_account_disabled};

pub(super) struct Tunnel {
    port: Arc<dyn GatewayTunnelPort>,
    current: Mutex<Current>,
    changes: tokio::sync::Mutex<()>,
    replay: noise::ReplayGuard,
}

#[derive(Default)]
struct Current {
    tunnel_id: Option<String>,
    public_key: Option<String>,
    state: TunnelState,
    session: Option<CancellationToken>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TunnelState {
    #[default]
    Off,
    Connecting,
    Connected,
}

#[derive(Debug, Serialize)]
pub(super) struct TunnelView {
    enabled: bool,
    state: TunnelState,
    public_key: Option<String>,
    tunnel_id: Option<String>,
}

#[derive(Deserialize)]
struct Toggle {
    enabled: bool,
}

pub(super) async fn set(
    state: &Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let tunnel = state.tunnel.as_ref().ok_or_else(butler_account_disabled)?;
    let body =
        super::read_body_with_limit(request.into_body(), super::MAX_REQUEST_BODY_SIZE).await?;
    let toggle: Toggle = serde_json::from_slice(&body).map_err(|_| HttpError::invalid_json())?;
    super::security_settings::ok(tunnel.set(state, toggle.enabled).await?)
}

impl Tunnel {
    pub(super) fn new(port: Arc<dyn GatewayTunnelPort>) -> Self {
        Self {
            port,
            current: Mutex::default(),
            changes: tokio::sync::Mutex::new(()),
            replay: noise::ReplayGuard::default(),
        }
    }

    pub(super) async fn start(state: &Arc<HttpState>) {
        if let Some(tunnel) = &state.tunnel
            && tunnel.restore(state).await.is_err()
        {
            tracing::info!(reason = "tunnel_restore_failed", "Tunnel stopped");
        }
    }

    async fn restore(&self, state: &Arc<HttpState>) -> Result<(), HttpError> {
        let saved = state.application.load_tunnel().await?;
        let id = saved["tunnel_id"].as_str().map(str::to_owned);
        if saved["enabled"] != true {
            self.current.lock().tunnel_id = id;
            return Ok(());
        }
        if self.port.account().await?.is_none() {
            return self.stop(state, socket::Stop::SignedOut).await;
        }
        let key = self.port.static_key().await?;
        if let Some(id) = id {
            self.spawn(state, id, key, None);
        } else {
            self.stop(state, socket::Stop::NotFound).await?;
        }
        Ok(())
    }

    async fn set(&self, state: &Arc<HttpState>, enabled: bool) -> Result<TunnelView, HttpError> {
        let change = self.changes.lock().await;
        if enabled == self.view().enabled {
            return Ok(self.view());
        }
        if enabled {
            if self.port.account().await?.is_none() {
                return Err(socket::Stop::SignedOut.error());
            }
            let id = self.port.allocate().await?;
            let key = self.port.static_key().await?;
            state
                .application
                .save_tunnel(json!({"enabled": true, "tunnel_id": id}))
                .await?;
            let (first, settled) = oneshot::channel();
            self.spawn(state, id, key, Some(first));
            drop(change);
            if let Ok(result) = settled.await {
                result?;
            }
        } else {
            let id = self.current.lock().tunnel_id.clone();
            state
                .application
                .save_tunnel(json!({"enabled": false, "tunnel_id": id}))
                .await?;
            self.turn_off(id);
        }
        Ok(self.view())
    }

    fn spawn(
        &self,
        state: &Arc<HttpState>,
        id: String,
        key: Zeroizing<[u8; 32]>,
        first: Option<oneshot::Sender<Result<(), HttpError>>>,
    ) {
        let session = state.shutdown.child_token();
        let public = PublicKey::from(&StaticSecret::from(*key));
        let mut current = self.current.lock();
        if let Some(previous) = current.session.replace(session.clone()) {
            previous.cancel();
        }
        current.tunnel_id = Some(id.clone());
        current.public_key = Some(URL_SAFE_NO_PAD.encode(public.as_bytes()));
        current.state = TunnelState::Connecting;
        tokio::spawn(socket::run(state.clone(), session, id, key, first));
    }

    fn turn_off(&self, id: Option<String>) {
        let mut current = self.current.lock();
        if let Some(session) = current.session.take() {
            session.cancel();
        }
        *current = Current {
            tunnel_id: id,
            ..Current::default()
        };
    }

    async fn stop(&self, state: &HttpState, stop: socket::Stop) -> Result<(), HttpError> {
        let id = if stop.keeps_id() {
            self.current.lock().tunnel_id.clone()
        } else {
            None
        };
        self.turn_off(id.clone());
        tracing::info!(reason = stop.code(), "Tunnel stopped");
        state
            .application
            .save_tunnel(json!({"enabled": false, "tunnel_id": id}))
            .await?;
        Ok(())
    }

    fn transition(&self, session: &CancellationToken, state: TunnelState) {
        let mut current = self.current.lock();
        if !session.is_cancelled() && current.state != state {
            current.state = state;
            tracing::info!(?state, "Tunnel state changed");
        }
    }

    pub(super) fn view(&self) -> TunnelView {
        let current = self.current.lock();
        let enabled = current.state != TunnelState::Off;
        TunnelView {
            enabled,
            state: current.state,
            public_key: current.public_key.clone(),
            tunnel_id: current.tunnel_id.clone().filter(|_| enabled),
        }
    }

    pub(super) async fn plan(&self) -> Result<Option<String>, HttpError> {
        Ok(self.port.plan().await?)
    }
}
