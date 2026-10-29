use std::{fs, path::PathBuf, sync::Arc};

use serde_json::{Value, json};

use super::*;
use crate::models::{ModelCatalog, ProviderAuth, ProviderConfigRequest, ProviderRequestConfigPort};
use butler_core::locale::LocaleCollation;
use butler_turn::btcc::ModelRoundError;

#[path = "tests/catalog_cache.rs"]
mod cache_contract;
mod local;

struct Clock;
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_757_808_000_000
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-p2c-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, relative: &str, value: &Value) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn owner(&self, environment: ModelConfigurationEnvironment) -> ModelConfiguration {
        ModelConfiguration::new(
            self.0.clone(),
            environment,
            Arc::new(Clock),
            Arc::new(ModelCatalog::new().unwrap()),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
            crate::models::provider_http_client().unwrap(),
            Arc::new(butler_core::configuration::ConfigurationWrites::new()),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn physical_config_resolves_all_provider_ids_and_registered_credentials() {
    let fixture = Fixture::new("providers");
    let environment = ModelConfigurationEnvironment {
        openai_api_key: Some("environment-openai".into()),
        os_platform: Some("darwin".into()),
        os_release: Some("25.0".into()),
        os_arch: Some("arm64".into()),
        ..Default::default()
    };
    let owner = fixture.owner(environment);
    let provider_ids = [
        "openai",
        "anthropic",
        "google",
        "xai",
        "qwen",
        "kimi",
        "zai",
        "zai-api",
        "opencode-go",
    ];
    let mut registered = Vec::new();
    let mut credentials = Vec::new();
    let mut refs = Vec::new();
    for provider in provider_ids {
        let model = owner
            .registration_catalog
            .view()
            .models
            .iter()
            .find(|model| model.provider_id == provider && model.runtime_supported)
            .unwrap();
        let credential_id = format!("credential-{provider}");
        if provider != "openai" {
            registered.push(json!({
                "provider_id":provider, "model_id":model.model_id,
                "auth_type":"api_key", "credential_id":credential_id
            }));
            credentials.push(json!({
                "id":credential_id, "provider_id":provider, "auth_type":"api_key",
                "label":provider, "secret":format!("secret-{provider}")
            }));
        }
        refs.push((provider.to_owned(), model.model_ref.clone()));
    }
    let local = json!({
        "model_id":"local-fixture", "server_url":"http://127.0.0.1:11434",
        "context_window_tokens":8192
    });
    fixture.write(
        "butler.config.json",
        &json!({"models":{"registered":registered,"local":[local]}}),
    );
    fixture.write(
        "auth/model-provider-credentials.json",
        &json!({"credentials":credentials}),
    );
    fixture.write(
        "auth/custom-model-credentials.json",
        &json!({"local/local-fixture":"local-secret"}),
    );

    for (provider, model_ref) in refs {
        let config = owner
            .resolve(ProviderConfigRequest {
                rejected_authorization: None,
                model_ref: &model_ref,
                butler_data: None,
            })
            .await
            .unwrap();
        assert_eq!(config.metadata.provider_id, provider);
        assert_eq!(config.wire_model, config.metadata.model_id);
        assert!(matches!(config.auth, ProviderAuth::ApiKey(_)));
        assert!(config.endpoint.as_str().starts_with("https://"));
    }
    let local = owner
        .resolve(ProviderConfigRequest {
            rejected_authorization: None,
            model_ref: "local/local-fixture",
            butler_data: None,
        })
        .await
        .unwrap();
    assert_eq!(local.metadata.provider_id, "local");
    match local.auth {
        ProviderAuth::ApiKey(value) => assert_eq!(value.as_str(), "local-secret"),
        _ => panic!("expected local API key"),
    }
    assert_eq!(
        local.endpoint.as_str(),
        "http://127.0.0.1:11434/v1/chat/completions"
    );
}

// test-category: security
#[tokio::test]
async fn registered_openai_key_overrides_environment_and_sizing_rereads_files() {
    let fixture = Fixture::new("reread");
    let owner = fixture.owner(ModelConfigurationEnvironment {
        openai_api_key: Some("environment-secret".into()),
        ..Default::default()
    });
    fixture.write(
        "butler.config.json",
        &json!({"models":{"registered":[{
            "provider_id":"openai", "model_id":"gpt-5.5", "auth_type":"api_key",
            "credential_id":"registered-key"
        }],"local":[{
            "model_id":"sized", "server_url":"http://127.0.0.1:8080",
            "context_window_tokens":8192
        }]}}),
    );
    fixture.write(
        "auth/model-provider-credentials.json",
        &json!({"credentials":[{
            "id":"registered-key", "provider_id":"openai", "auth_type":"api_key",
            "secret":"registered-secret"
        }]}),
    );
    for model in ["openai/gpt-5.5", "openai/gpt-6-luna"] {
        let config = owner
            .resolve(ProviderConfigRequest {
                rejected_authorization: None,
                model_ref: model,
                butler_data: None,
            })
            .await
            .unwrap();
        assert_eq!(config.wire_model, model.strip_prefix("openai/").unwrap());
        match config.auth {
            ProviderAuth::ApiKey(value) => assert_eq!(value.as_str(), "registered-secret"),
            _ => panic!("expected the registered provider key"),
        }
        assert_eq!(
            config.endpoint.as_str(),
            "https://api.openai.com/v1/responses"
        );
    }

    cache_contract::fresh_secret_with_same_mask(&fixture, &owner).await;
    cache_contract::fresh_observation_time(&owner);

    let first = owner.sizing_snapshot(None).unwrap();
    let warm = owner.sizing_snapshot(None).unwrap();
    assert_eq!(
        serde_json::to_value(first.view()).unwrap(),
        serde_json::to_value(warm.view()).unwrap()
    );
    assert_eq!(
        first
            .find_model_metadata(Some("local/sized"))
            .unwrap()
            .context_window_tokens,
        Some(8192.0)
    );
    fixture.write(
        "butler.config.json",
        &json!({"models":{"local":[{
            "model_id":"sized", "server_url":"http://127.0.0.1:8080",
            "context_window_tokens":16384
        }]}}),
    );
    let second = owner.sizing_snapshot(None).unwrap();
    assert_eq!(
        second
            .find_model_metadata(Some("local/sized"))
            .unwrap()
            .context_window_tokens,
        Some(16384.0)
    );
}

// test-category: security
#[tokio::test]
async fn registered_chatgpt_ignores_api_key_and_legacy_file() {
    let fixture = Fixture::new("chatgpt-registration");
    fixture.write(
        "auth/chatgpt.json",
        &json!({"schema_version":1,"client_id":"issued-client",
        "subject":"subject","access_token":"registration-token","refresh_token":"distinctive-refresh",
        "id_token":"distinctive-id-token", "signed_in_at":"2026-09-14T00:00:00Z",
        "expires_at":i64::MAX,"scopes":["chatgpt.tokens.use.direct"]}),
    );
    fixture.write(
        "auth/openai-codex.json",
        &json!({"accessToken":"legacy-token"}),
    );
    fixture.write(
        "butler.config.json",
        &json!({"models":{"registered":[{
        "provider_id":"openai","model_id":"gpt-5.5","auth_type":"codex_oauth"}]}}),
    );
    let owner = fixture.owner(ModelConfigurationEnvironment {
        openai_api_key: Some("api-key".into()),
        ..Default::default()
    });
    let config = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/gpt-5.5",
            butler_data: None,
            rejected_authorization: None,
        })
        .await
        .unwrap();
    assert!(
        matches!(config.auth, ProviderAuth::ChatGptPlan { authorization, .. } if authorization.as_str() == "Bearer registration-token")
    );
    let listing = owner.oauth_credentials().await.unwrap();
    assert_eq!(listing.credentials.len(), 2);
    let serialized = serde_json::to_string(&listing).unwrap();
    for secret in [
        "registration-token",
        "distinctive-refresh",
        "distinctive-id-token",
        "legacy-token",
        "access_token",
        "refresh_token",
        "id_token",
        "accessToken",
    ] {
        assert!(
            !serialized.contains(secret),
            "inventory must exclude secrets and token fields"
        );
    }
    assert_eq!(listing.credentials[0].obtained_at, Some(1_789_344_000));
    assert!(
        listing
            .credentials
            .iter()
            .all(|row| row.expires_at.is_none())
    );
}

#[tokio::test]
async fn missing_registration_credential_and_provider_mismatch_are_rejected() {
    let fixture = Fixture::new("rejections");
    let owner = fixture.owner(ModelConfigurationEnvironment {
        ..Default::default()
    });
    let error = owner
        .resolve(ProviderConfigRequest {
            rejected_authorization: None,
            model_ref: "anthropic/claude-sonnet-5",
            butler_data: None,
        })
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "provider_configuration_missing");

    fixture.write(
        "butler.config.json",
        &json!({"models":{"registered":[{
            "provider_id":"anthropic", "model_id":"claude-sonnet-5",
            "auth_type":"api_key", "credential_id":"wrong-provider"
        }]}}),
    );
    fixture.write(
        "auth/model-provider-credentials.json",
        &json!({"credentials":[{
            "id":"wrong-provider", "provider_id":"google", "auth_type":"api_key", "secret":"secret"
        }]}),
    );
    let error = owner
        .resolve(ProviderConfigRequest {
            rejected_authorization: None,
            model_ref: "anthropic/claude-sonnet-5",
            butler_data: None,
        })
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "provider_auth_missing");
}

#[tokio::test]
async fn prompt_resolution_preserves_explicit_precedence_and_static_alias() {
    let fixture = Fixture::new("static-openai-alias");
    fixture.write(
        "butler.config.json",
        &json!({"system":{"openaiModel":"gpt-6-astra","openaiReasoningEffort":"low"}}),
    );
    let owner = fixture.owner(ModelConfigurationEnvironment {
        openai_api_key: Some("discovery-key".into()),
        openai_base_url: Some("http://127.0.0.1:9/v1".into()),
        openai_model: Some(" gpt-6-luna ".into()),
        openai_reasoning_effort: Some("high".into()),
        ..Default::default()
    });
    assert_eq!(
        owner
            .effective_prompt_model(Some(" openai/gpt-5.5 "))
            .unwrap(),
        "openai/gpt-5.5"
    );
    assert_eq!(
        owner.effective_prompt_model(None).unwrap(),
        "openai/gpt-6.1-sol"
    );
    let config = owner
        .resolve(ProviderConfigRequest {
            rejected_authorization: None,
            model_ref: "openai/auto:codex-latest",
            butler_data: None,
        })
        .await
        .unwrap();
    let configured = owner
        .resolve(ProviderConfigRequest {
            rejected_authorization: None,
            model_ref: "",
            butler_data: None,
        })
        .await
        .unwrap();
    assert_eq!(config.wire_model, "gpt-6.1-sol");
    assert_eq!(configured.wire_model, "gpt-6-luna");
    assert_eq!(
        config.prompt_reasoning_effort,
        Some(crate::models::ReasoningEffort::High)
    );

    let fallback = Fixture::new("openai-nullish-fallback");
    fallback.write(
        "butler.config.json",
        &json!({"system":{
            "openaiReasoningEffort":"high ",
            "workerModel":"",
            "butlerModel":"",
            "defaultModel":"openai/gpt-5.6-astra"
        }}),
    );
    let owner = fallback.owner(ModelConfigurationEnvironment {
        openai_api_key: Some("key".into()),
        ..Default::default()
    });
    assert_eq!(
        owner.effective_prompt_model(None).unwrap(),
        "openai/gpt-5.6-astra"
    );
    assert!(matches!(
        owner.effective_prompt_model(Some("auto:codex-latest")),
        Err(ModelRoundError::InvocationFailure { .. })
    ));
    let config = owner
        .resolve(ProviderConfigRequest {
            rejected_authorization: None,
            model_ref: "openai/gpt-5.5",
            butler_data: None,
        })
        .await
        .unwrap();
    assert_eq!(
        config.prompt_reasoning_effort,
        Some(crate::models::ReasoningEffort::Medium)
    );
    let lower_default = owner
        .resolve(ProviderConfigRequest {
            rejected_authorization: None,
            model_ref: "",
            butler_data: None,
        })
        .await
        .unwrap();
    assert_eq!(lower_default.wire_model, "gpt-5.6-astra");
}
