//! Journal dispatch before trusted native input; uncertain actions are never replayed.
use super::client::Client;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AdapterOutcome, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture, PlanBinding,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
pub(super) struct BrowserEffectAdapter {
    pub client: Client,
    pub tab: Value,
    pub args: Value,
}
impl EffectAdapter for BrowserEffectAdapter {
    fn capability(&self) -> &'static str {
        "browser_act"
    }
    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }
    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        Ok(target.into())
    }
    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        Ok(target.into())
    }
    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        Ok(input.clone())
    }
    fn dispatch<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            let result = self
                .client
                .call(
                    if self.args.get("dialog").is_some() {
                        "tab.dialog"
                    } else {
                        "tab.act"
                    },
                    &self.tab,
                    &self.args,
                    signal,
                )
                .await;
            JsonDocument::from_value(&result)
                .map(AdapterOutcome::Applied)
                .map_err(|e| EffectFailure::adapter(e.to_string()))
        })
    }
    fn reconcile<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        _: &'a CancellationToken,
        attempts: i64,
        _: Option<&'a butler_turn::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            Ok(if attempts == 0 {
                AdapterOutcome::NotApplied(EffectAdapterError::new(
                    "not_dispatched",
                    "No browser step dispatched.",
                ))
            } else {
                AdapterOutcome::Uncertain(Some(EffectAdapterError::new(
                    "browser_result_unknown",
                    "Observe before deciding the next step; never replay this batch.",
                )))
            })
        })
    }
}
