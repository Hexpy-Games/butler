use std::{path::PathBuf, sync::Arc};

use butler_gateway::gateway::{
    ApplicationFuture, GatewayApplicationError, GatewayTunnelPort, TunnelAccount,
};
use reqwest::Method;
use serde_json::Value;
use zeroize::Zeroizing;

use super::super::runtime_ports::setup::butler_account::{
    ButlerAccount, DEFAULT_API_URL, check, signed_out, unavailable,
};
use crate::host::service::configuration::local_credentials;

pub(super) struct AppTunnelPort {
    pub(super) account: Arc<ButlerAccount>,
    pub(super) data_root: PathBuf,
}

impl GatewayTunnelPort for AppTunnelPort {
    fn account(&self) -> ApplicationFuture<Option<TunnelAccount>> {
        let account = self.account.clone();
        Box::pin(async move {
            Ok(account.read().await?.map(|stored| TunnelAccount {
                base_url: account.base_url.clone(),
                qr_cloud: (account.base_url != DEFAULT_API_URL).then(|| account.base_url.clone()),
                device_token: Zeroizing::new(stored.device_token),
            }))
        })
    }

    fn allocate(&self) -> ApplicationFuture<String> {
        let account = self.account.clone();
        Box::pin(async move {
            let stored = account.read().await?.ok_or_else(signed_out)?;
            let response = account
                .send(Method::POST, "/v1/tunnel", Some(&stored.device_token), None)
                .await?;
            let value: Value = check(response, 200)
                .await?
                .json()
                .await
                .map_err(|_| unavailable())?;
            let id = value["tunnel_id"].as_str().ok_or_else(unavailable)?;
            let valid = id.strip_prefix("tun_").is_some_and(|suffix| {
                suffix.len() == 26
                    && suffix
                        .bytes()
                        .all(|byte| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&byte))
            });
            if !valid {
                return Err(unavailable());
            }
            Ok(id.to_owned())
        })
    }

    fn static_key(&self) -> ApplicationFuture<Zeroizing<[u8; 32]>> {
        let data_root = self.data_root.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || local_credentials::tunnel_noise_key(&data_root))
                .await
                .map_err(GatewayApplicationError::internal_from)?
                .map_err(GatewayApplicationError::internal_from)
        })
    }

    fn plan(&self) -> ApplicationFuture<Option<String>> {
        let account = self.account.clone();
        Box::pin(async move {
            let status = account.status(None).await?;
            Ok(status["entitlements"]["plan"].as_str().map(str::to_owned))
        })
    }
}
