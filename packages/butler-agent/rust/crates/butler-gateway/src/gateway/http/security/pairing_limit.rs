//! Rejected pairing and link codes, per client and across all clients.
use super::super::HttpError;
use crate::gateway::rate_limit::FixedWindowRateLimiter;
use axum::{body::Body, extract::ConnectInfo, http::Request};
use std::{net::SocketAddr, time::Duration};

const PER_CLIENT: u64 = 10;
const ALL_CLIENTS: u64 = 30;
const WINDOW: Duration = Duration::from_secs(60);
const ALL: &str = "all";

pub(in crate::gateway::http) struct PairingLimits {
    per_client: FixedWindowRateLimiter,
    all: FixedWindowRateLimiter,
}

impl Default for PairingLimits {
    fn default() -> Self {
        Self {
            per_client: FixedWindowRateLimiter::new(PER_CLIENT, WINDOW),
            all: FixedWindowRateLimiter::new(ALL_CLIENTS, WINDOW),
        }
    }
}

impl PairingLimits {
    pub(in crate::gateway::http) fn check(&self, key: &str) -> Result<(), HttpError> {
        if let Some(wait) = self
            .per_client
            .retry_after(key)
            .max(self.all.retry_after(ALL))
        {
            let secs = wait.as_secs() + u64::from(wait.subsec_nanos() != 0);
            return Err(HttpError::RateLimited {
                retry_after: secs.max(1),
            });
        }
        Ok(())
    }

    pub(in crate::gateway::http) fn reject(&self, key: &str) {
        self.per_client.consume(key.to_owned());
        self.all.consume(ALL.to_owned());
    }
}

pub(in crate::gateway::http) fn client_key(request: &Request<Body>) -> String {
    if request
        .extensions()
        .get::<super::super::listeners::TunnelPeer>()
        .is_some()
    {
        return "tunnel".into();
    }
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or_else(
            || "no-peer".to_owned(),
            |peer| peer.0.ip().to_canonical().to_string(),
        )
}
