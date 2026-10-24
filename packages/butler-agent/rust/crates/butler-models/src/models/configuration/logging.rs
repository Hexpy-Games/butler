//! Register configured credentials once; mutations register new values before saving.
use super::{ModelConfiguration, ModelConfigurationEnvironment, ModelConfigurationRead};

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
impl ModelConfiguration {
    pub(super) async fn register_log_secrets(&self, read: &ModelConfigurationRead) {
        self.log_secrets
            .get_or_init(|| async {
                for record in &read.credentials {
                    if let Ok(secret) = self.credential_secret(&self.data_root, record).await {
                        butler_log::register_secret_for(
                            &format!("credential:{}:{}", record.provider_id, record.id),
                            secret.expose(),
                        );
                    }
                }
            })
            .await;
    }
}
