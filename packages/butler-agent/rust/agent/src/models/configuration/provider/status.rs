//! Read-only status facade over the provider-owned prompt-cache policy.

use crate::models::ProviderPromptCachePolicy;

use super::ModelConfiguration;

impl ModelConfiguration {
    /// Reads the cache policy without resolving auth or preparing a request.
    pub(crate) fn status_prompt_cache_policy(&self) -> ProviderPromptCachePolicy {
        let config = super::super::read_object_sync(&self.data_root.join("butler.config.json"));
        self.prompt_cache_from_config(&config, &self.data_root)
    }
}
