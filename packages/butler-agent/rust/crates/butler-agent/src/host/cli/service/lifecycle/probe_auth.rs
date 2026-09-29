//! Bearer tokens the CLI may present to the service's App gateway readiness
//! probe. The gateway always requires the data folder's token (or the file
//! `BUTLER_APP_LOCAL_AUTH_FILE` names for the process that started it), so any
//! controller of the same DATA can authenticate, including next to an Agent
//! the App started.

use std::net::IpAddr;

use crate::host::ServiceConfiguration;
use crate::host::service::configuration::data_folder_token;

/// Candidate tokens in order: the token this CLI resolved for DATA (its
/// `BUTLER_APP_LOCAL_AUTH_FILE`, else the data folder's), then the data
/// folder's own token when an override named another. Duplicates are dropped.
pub(super) fn probe_tokens(config: &ServiceConfiguration) -> Vec<String> {
    let mut tokens = Vec::new();
    let configured = config.app.gateway_config().local_auth;
    if configured.required
        && let Some(token) = configured.token()
    {
        tokens.push(token.to_string());
    }
    if let Some(token) = data_folder_token(&config.data_root)
        && !tokens.contains(&token)
    {
        tokens.push(token);
    }
    tokens
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
            "http://192.0.2.10:18765",
            "http://0.0.0.0:18765",
            "http://example.com:18765",
            "not a url",
        ] {
            assert!(!is_loopback_endpoint(endpoint), "{endpoint}");
        }
    }
}
