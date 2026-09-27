//! Bearer tokens the CLI may present to the service's App gateway readiness
//! probe. The service may have been started by the App with the App's token,
//! which this CLI process does not have in its environment; the App keeps that
//! token in DATA, so any controller of the same DATA can authenticate.

use std::net::IpAddr;
use std::path::Path;

use serde::Deserialize;

use crate::host::ServiceConfiguration;

/// Schema of the App's local-auth file.
const APP_LOCAL_AUTH_SCHEMA: &str = "butler.app-local-agent-auth.v1";
/// The App's local-auth file, relative to DATA.
const APP_LOCAL_AUTH_FILE: &str = "app/runtime/auth/local-agent-auth.json";

#[derive(Deserialize)]
struct AppLocalAuthFile {
    schema: String,
    token: String,
}

/// Candidate tokens in order: this CLI's configured App token, then the App's
/// token file in DATA. Duplicates are dropped.
pub(super) fn probe_tokens(config: &ServiceConfiguration) -> Vec<String> {
    let mut tokens = Vec::new();
    let configured = config.app.gateway_config().local_auth;
    if configured.required
        && let Some(token) = configured.token()
    {
        tokens.push(token.to_owned());
    }
    if let Some(token) = app_local_auth_token(&config.data_root)
        && !tokens.contains(&token)
    {
        tokens.push(token);
    }
    tokens
}

/// The App's token when its file is present and well formed; any other state
/// means the App has not provisioned a token for this DATA.
fn app_local_auth_token(data_root: &Path) -> Option<String> {
    let bytes = std::fs::read(data_root.join(APP_LOCAL_AUTH_FILE)).ok()?;
    let file: AppLocalAuthFile = serde_json::from_slice(&bytes).ok()?;
    let token = file.token.trim();
    (file.schema == APP_LOCAL_AUTH_SCHEMA && !token.is_empty()).then(|| token.to_owned())
}

/// Tokens are only ever sent to a loopback App gateway.
pub(super) fn is_loopback_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback()),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_loopback_endpoint;

    /// Security boundary: the App token never leaves the machine.
    #[test]
    fn probe_tokens_are_only_sent_to_loopback_gateways() {
        for endpoint in [
            "http://127.0.0.1:18765",
            "http://[::1]:18765",
            "http://localhost:18765",
        ] {
            assert!(is_loopback_endpoint(endpoint), "{endpoint}");
        }
        for endpoint in [
            "http://192.168.0.10:18765",
            "http://0.0.0.0:18765",
            "http://example.com:18765",
            "not a url",
        ] {
            assert!(!is_loopback_endpoint(endpoint), "{endpoint}");
        }
    }
}
