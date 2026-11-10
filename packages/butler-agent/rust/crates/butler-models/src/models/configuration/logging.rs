//! Configured endpoints are registered at start. Stored keys are registered
//! for log masking when the process reads (`credential_secret`) or saves
//! (`write_credential`) them, never by reading every store at start.
use super::ModelConfigurationEnvironment;

pub(super) fn register_environment_endpoints(environment: &ModelConfigurationEnvironment) {
    for endpoint in [
        &environment.openai_base_url,
        &environment.chatgpt_api_base_url,
        &environment.chatgpt_auth_issuer,
    ]
    .into_iter()
    .flatten()
    .chain(environment.hosted_provider_base_urls.values())
    {
        butler_log::register_endpoint(endpoint);
    }
}
