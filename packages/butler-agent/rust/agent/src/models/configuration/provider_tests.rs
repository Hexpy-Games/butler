use std::{fs, path::PathBuf, sync::Arc};

use serde_json::{Value, json};

use super::*;
use crate::{
    btcc::ModelRoundError,
    locale::LocaleCollation,
    models::{
        ModelCatalog, ProviderAuth, ProviderAuthMode, ProviderConfigRequest,
        ProviderRequestConfigPort,
    },
};

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
            Arc::new(crate::configuration::ConfigurationWrites::new()),
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
            model_ref: "local/local-fixture",
            butler_data: None,
        })
        .await
        .unwrap();
    assert_eq!(local.metadata.provider_id, "local");
    match local.auth {
        ProviderAuth::ApiKey(value) => assert_eq!(value, "local-secret"),
        _ => panic!("expected local API key"),
    }
    assert_eq!(
        local.endpoint.as_str(),
        "http://127.0.0.1:11434/v1/chat/completions"
    );
}

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
    let config = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/gpt-5.5",
            butler_data: None,
        })
        .await
        .unwrap();
    match config.auth {
        ProviderAuth::ApiKey(value) => assert_eq!(value, "registered-secret"),
        _ => panic!("expected api key"),
    }
    assert_eq!(
        config.endpoint.as_str(),
        "https://api.openai.com/v1/responses"
    );

    let first = owner.sizing_snapshot(None).unwrap();
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

#[tokio::test]
async fn codex_profile_precedes_codex_file_and_authorize_url_matches_source() {
    let fixture = Fixture::new("codex-profile");
    let profile = fixture.0.join("profile.json");
    let codex = fixture.0.join("codex-auth.json");
    fixture.write(
        "profile.json",
        &json!({
            "type":"oauth", "accessToken":"profile-token", "unknown":"kept",
            "expiresAt":0
        }),
    );
    fixture.write(
        "codex-auth.json",
        &json!({"tokens":{"access_token":"codex-token"}}),
    );
    fixture.write(
        "butler.config.json",
        &json!({"models":{"registered":[{
            "provider_id":"openai", "model_id":"gpt-5.5", "auth_type":"codex_oauth"
        }]}}),
    );
    let owner = fixture.owner(ModelConfigurationEnvironment {
        openai_api_key: Some("must-not-override-codex-route".into()),
        butler_codex_auth_profile: Some(profile),
        codex_auth_json: Some(codex),
        os_platform: Some("darwin".into()),
        os_release: Some("25.0".into()),
        os_arch: Some("arm64".into()),
        ..Default::default()
    });
    let config = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/gpt-5.5",
            butler_data: None,
        })
        .await
        .unwrap();
    match config.auth {
        ProviderAuth::Codex {
            mode,
            authorization,
            ..
        } => {
            assert_eq!(mode, ProviderAuthMode::CodexSubscription);
            assert_eq!(authorization, "Bearer profile-token");
        }
        _ => panic!("expected codex auth"),
    }
    let verifier = "fixture-verifier";
    assert_eq!(
        auth::pkce_challenge(verifier),
        "8Dw_rXYDuMBDOofOjlxvMNEALsULmI6c47hS_o9Dkqg"
    );
    let url = owner
        .openai_authorize_url("http://127.0.0.1:1455/callback", "challenge", "state", None)
        .unwrap();
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "client_id")
            .unwrap()
            .1,
        "app_EMoamEEZ73f0CkXaXp7hrann"
    );
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "code_challenge_method")
            .unwrap()
            .1,
        "S256"
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
            model_ref: "anthropic/claude-sonnet-5",
            butler_data: None,
        })
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "provider_auth_missing");
}

#[tokio::test]
async fn prompt_resolution_preserves_explicit_precedence_and_dynamic_discovery() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let bodies = [
            r#"{"data":[{"id":"gpt-5.6-luna"},{"id":"gpt-5.5-codex"},{"id":"gpt-5.6-astra"},{"id":"not-selectable"}]}"#,
            r#"{"data":[{"id":"gpt-5.6-luna"},{"id":"gpt-5.5-codex"},{"id":"gpt-5.6-astra"},{"id":"not-selectable"}]}"#,
            r#"{"data":[{"id":"gpt-.5-codex"},{"id":"gpt-5.-codex"},{"id":"gpt-5..6-codex"},{"id":"gpt-5.4-codex"}]}"#,
            r#"{"data":[{"id":"gpt-5-codex-😀😀"},{"id":"gpt-5-codex-aaaaa"}]}"#,
            r#"{"data":[{"id":"gpt-5.5-codex-100"},{"id":"gpt-5.6-codex-99"}]}"#,
        ];
        for body in bodies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer discovery-key")
            );
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let fixture = Fixture::new("dynamic-openai");
    fixture.write(
        "butler.config.json",
        &json!({"system":{"openaiModel":"auto:codex-latest","openaiReasoningEffort":"low"}}),
    );
    let owner = fixture.owner(ModelConfigurationEnvironment {
        openai_api_key: Some("discovery-key".into()),
        openai_base_url: Some(format!("http://{address}/v1")),
        openai_model: Some(" auto:codex-latest ".into()),
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
        "openai/gpt-5.5-codex"
    );
    let config = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/auto:codex-latest",
            butler_data: None,
        })
        .await
        .unwrap();
    let configured_dynamic = owner
        .resolve(ProviderConfigRequest {
            model_ref: "",
            butler_data: None,
        })
        .await
        .unwrap();
    let malformed_versions = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/auto:codex-latest",
            butler_data: None,
        })
        .await
        .unwrap();
    let unicode_tie = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/auto:codex-latest",
            butler_data: None,
        })
        .await
        .unwrap();
    let first_version_pattern = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/auto:codex-latest",
            butler_data: None,
        })
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(config.wire_model, "gpt-5.6-astra");
    assert_eq!(configured_dynamic.wire_model, "gpt-5.6-astra");
    assert_eq!(malformed_versions.wire_model, "gpt-5.4-codex");
    assert_eq!(unicode_tie.wire_model, "gpt-5-codex-aaaaa");
    assert_eq!(first_version_pattern.wire_model, "gpt-5.6-codex-99");
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
        "openai/gpt-5.5-codex"
    );
    assert!(matches!(
        owner.effective_prompt_model(Some("auto:codex-latest")),
        Err(ModelRoundError::InvocationFailure { .. })
    ));
    let config = owner
        .resolve(ProviderConfigRequest {
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
            model_ref: "",
            butler_data: None,
        })
        .await
        .unwrap();
    assert_eq!(lower_default.wire_model, "gpt-5.5-codex");
}
