//! Register configured credentials once; mutations register new values before saving.
use super::{ModelConfiguration, ModelConfigurationRead};
impl ModelConfiguration {
    pub(super) async fn register_log_secrets(&self, read: &ModelConfigurationRead) {
        self.log_secrets
            .get_or_init(|| async {
                for record in &read.credentials {
                    if let Ok(secret) = self.credential_secret(&self.data_root, record).await {
                        butler_log::register_secret(secret.expose());
                    }
                }
            })
            .await;
    }
}
