//! Legacy model-path OAuth token URL, retained until P2.

use reqwest::Url;

use super::{AuthError, error};
use crate::models::configuration::ModelConfigurationEnvironment;

const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub(super) fn token_url(environment: &ModelConfigurationEnvironment) -> Result<Url, AuthError> {
    Url::parse(environment.oauth_token_url.as_deref().unwrap_or(TOKEN_URL))
        .map_err(|source| invalid_url("OpenAI OAuth token URL is invalid.").with_source(source))
}

fn invalid_url(message: &'static str) -> AuthError {
    error("provider_auth_url_invalid", message)
}
