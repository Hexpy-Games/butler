//! The host side of Settings → Security (#229): the connection code is the
//! gateway token file (`BUTLER_APP_LOCAL_AUTH_FILE`, else the data folder's
//! `app/runtime/auth/local-agent-auth.json`), and the exposure lives in
//! `gateways/app.json` `config` (`remoteAccessEnabled`, `allowedHosts`),
//! which the next start reads.

use std::path::PathBuf;

use serde_json::{Map, Value};

use butler_gateway::gateway::{
    ApplicationFuture, GatewayApplicationError, GatewayExposure, GatewaySecurityStore,
    RotatedConnectionCode,
};

use crate::host::ResolvedInstallation;
use crate::host::service::configuration::local_credentials::{
    self, LocalCredentialError, RotatedToken,
};

pub(crate) struct AppSecurityStore {
    data_root: PathBuf,
    installation: ResolvedInstallation,
}

impl AppSecurityStore {
    pub(crate) fn new(data_root: PathBuf, installation: ResolvedInstallation) -> Self {
        Self {
            data_root,
            installation,
        }
    }
}

impl GatewaySecurityStore for AppSecurityStore {
    fn connection_code_created_at(&self) -> ApplicationFuture<Option<String>> {
        let path = local_credentials::token_file(&self.data_root);
        Box::pin(async move {
            let read =
                tokio::task::spawn_blocking(move || local_credentials::token_created_at(&path));
            read.await
                .map_err(GatewayApplicationError::internal_from)?
                .map_err(credential_error)
        })
    }

    fn rotate_connection_code(&self) -> ApplicationFuture<RotatedConnectionCode> {
        let path = local_credentials::token_file(&self.data_root);
        Box::pin(async move {
            let rotate =
                tokio::task::spawn_blocking(move || local_credentials::rotate_token(&path));
            let RotatedToken { token, created_at } = rotate
                .await
                .map_err(GatewayApplicationError::internal_from)?
                .map_err(credential_error)?;
            Ok(RotatedConnectionCode {
                code: token,
                created_at: Some(created_at),
            })
        })
    }

    fn save_exposure(&self, exposure: GatewayExposure) -> ApplicationFuture<()> {
        let data_root = self.data_root.clone();
        let installation = self.installation.clone();
        Box::pin(async move {
            let mut patch = Map::new();
            patch.insert(
                "remoteAccessEnabled".into(),
                Value::Bool(exposure.remote_access_enabled),
            );
            patch.insert(
                "allowedHosts".into(),
                Value::Array(
                    exposure
                        .allowed_hosts
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            );
            crate::host::cli::gateway::patch_app_config(&data_root, &installation, patch)
                .await
                .map_err(|error| {
                    public_error(
                        "security_settings_unavailable",
                        "Security settings could not be saved.",
                    )
                    .with_source(error)
                })
        })
    }
}

fn credential_error(error: LocalCredentialError) -> GatewayApplicationError {
    public_error(
        "connection_code_unavailable",
        "The connection code could not be updated.",
    )
    .with_source(error)
}

fn public_error(code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 500,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}
