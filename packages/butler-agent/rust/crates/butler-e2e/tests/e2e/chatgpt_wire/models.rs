use super::*;
use butler_models::models::{
    ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
    ProviderConfigRequest, ProviderRequestConfigPort,
};
struct Clock;
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        chrono::Utc::now().to_rfc3339()
    }
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}
pub(super) async fn auto_offline(s: &Scenario) -> Result<(), HarnessError> {
    let owner = ModelConfiguration::new(
        s.sandbox.data.clone(),
        ModelConfigurationEnvironment {
            chatgpt_api_base_url: Some("http://127.0.0.1:9/v1".into()),
            ..Default::default()
        },
        Arc::new(Clock),
        Arc::new(ModelCatalog::new().unwrap()),
        Arc::new(butler_core::locale::LocaleCollation::new("en-US").unwrap()),
        butler_models::models::provider_http_client()?,
        Arc::new(butler_core::configuration::ConfigurationWrites::new()),
    )
    .unwrap();
    for _ in 0..2 {
        let config = owner
            .resolve(ProviderConfigRequest {
                model_ref: "openai/auto:codex-latest",
                butler_data: None,
                rejected_authorization: None,
            })
            .await
            .map_err(|e| butler_e2e::e2e::harness_error(e.code))?;
        assert_eq!(config.wire_model, "gpt-6-luna");
    }
    Ok(())
}
