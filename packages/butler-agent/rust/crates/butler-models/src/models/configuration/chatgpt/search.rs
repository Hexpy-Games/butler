//! Official plan search reuses credential rotation, catalog and body finalization.
use super::{Error, ModelConfiguration};
use crate::models::{
    ProviderAuth,
    configuration::{
        auth::{AuthError, AuthOwner},
        environment::merge_private_auth_environment,
    },
};
use serde_json::{Map, Value};
use std::{collections::HashMap, sync::Arc};
impl ModelConfiguration {
    pub async fn chatgpt_search_model(
        self: &Arc<Self>,
        requested: Option<&str>,
    ) -> Result<String, Error> {
        let model = if let Some(model) = requested {
            model.to_owned()
        } else {
            let config = self.clone();
            tokio::task::spawn_blocking(move || config.effective_default_model())
                .await
                .map_err(|_| "provider_model_unavailable")?
                .map_err(|_| "provider_model_unavailable")?
        };
        let metadata = self
            .registration_catalog
            .find_model_metadata(Some(&model))
            .ok_or("provider_model_unavailable")?;
        if metadata.provider_id != "openai" {
            return Err("provider_model_unavailable");
        }
        let models = self
            .chatgpt_models()
            .await?
            .ok_or("provider_model_unavailable")?;
        models
            .iter()
            .any(|m| m.slug == metadata.model_id)
            .then_some(metadata.model_id)
            .ok_or("provider_model_unavailable")
    }
    pub async fn resolve_chatgpt_auth_for_web_search(
        &self,
        private: &HashMap<String, String>,
        rejected: Option<&str>,
    ) -> Result<ProviderAuth, AuthError> {
        let mut environment = self.environment.clone();
        merge_private_auth_environment(&mut environment, private);
        AuthOwner {
            data_root: &self.data_root,
            environment: &environment,
            clock: &self.clock,
            revision: &self.account_revision,
        }
        .resolve_chatgpt(rejected)
        .await
    }
}
/// Hosted tools keep their Responses shape; the shared finalizer owns restrictions.
pub fn finalize_search(body: &mut Map<String, Value>, registration: &str, model: &str) {
    crate::models::provider::chatgpt_plan::finalize(
        body,
        &Some((registration.into(), model.into())),
    );
}
