//! OAuth protocol URLs and URLSearchParams-compatible replacement.

use reqwest::Url;

use super::{AuthError, error, trimmed};
use crate::models::configuration::ModelConfigurationEnvironment;

const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE: &str = "openid profile email offline_access";

pub(super) fn authorize(
    environment: &ModelConfigurationEnvironment,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    scope: Option<&str>,
) -> Result<Url, AuthError> {
    let base = environment
        .oauth_authorize_url
        .as_deref()
        .unwrap_or(AUTHORIZE_URL);
    let mut url =
        Url::parse(base).map_err(|_| invalid_url("OpenAI OAuth authorize URL is invalid."))?;
    let client_id = trimmed(environment.oauth_client_id.as_deref()).unwrap_or(CLIENT_ID);
    let scope = scope
        .filter(|value| !value.is_empty())
        .or_else(|| trimmed(environment.oauth_scope.as_deref()))
        .unwrap_or(SCOPE);
    let originator = trimmed(environment.oauth_originator.as_deref()).unwrap_or("butler");
    let mut pairs = url.query_pairs().into_owned().collect::<Vec<_>>();
    for (key, value) in [
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("scope", scope),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
    ] {
        set(&mut pairs, key, value);
    }
    if !originator.is_empty() {
        set(&mut pairs, "originator", originator);
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
    Ok(url)
}

pub(super) fn token_url(environment: &ModelConfigurationEnvironment) -> Result<Url, AuthError> {
    Url::parse(environment.oauth_token_url.as_deref().unwrap_or(TOKEN_URL))
        .map_err(|_| invalid_url("OpenAI OAuth token URL is invalid."))
}

fn set(pairs: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some(index) = pairs.iter().position(|(candidate, _)| candidate == key) {
        pairs[index].1 = value.into();
        let mut cursor = index + 1;
        while cursor < pairs.len() {
            if pairs[cursor].0 == key {
                pairs.remove(cursor);
            } else {
                cursor += 1;
            }
        }
    } else {
        pairs.push((key.into(), value.into()));
    }
}

fn invalid_url(message: &'static str) -> AuthError {
    error("provider_auth_url_invalid", message)
}
