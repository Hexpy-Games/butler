//! One authentication retry and one capability resend per logical round.
use super::{memo, recovery};
use crate::models::{ProviderAuth, ProviderRequestConfig};
use butler_turn::btcc::ProviderRequestError;
use serde_json::Value;
#[derive(Default)]
pub(in crate::models::provider) struct Retry {
    pub rejected: Option<zeroize::Zeroizing<String>>,
    recovered: bool,
}
impl Retry {
    pub(in crate::models::provider) fn decide(
        &mut self,
        config: &ProviderRequestConfig,
        error: &mut ProviderRequestError,
        body: Option<&Value>,
        body_revision: Option<&str>,
    ) -> bool {
        let ProviderAuth::ChatGptPlan { authorization, .. } = &config.auth else {
            return false;
        };
        if error.status_code == Some(401) && self.rejected.is_none() {
            self.rejected = Some(authorization.clone());
            return true;
        }
        let Some(key) = memo(config) else {
            return false;
        };
        let (Some(body), Some(revision)) = (body, body_revision) else {
            return false;
        };
        if recovery::rejected(error, body, &key, self.recovered, revision) {
            self.recovered = true;
            return true;
        }
        false
    }
    pub(in crate::models::provider) fn authorization(&self) -> Option<&str> {
        self.rejected.as_ref().map(|s| s.as_str())
    }
}
