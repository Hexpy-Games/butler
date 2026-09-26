use std::fs;

use super::*;
use crate::btcc::AdmissionModelCatalogPort;
use serde_json::json;

struct Clock;
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_789_344_000_000
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("butler-native-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(root)
    }
    fn write(&self, path: &str, value: &Value) {
        let path = self.0.join(path);
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
async fn actual_config_reads_preserve_first_records_defaults_and_secret_boundaries() {
    let fixture = Fixture::new();
    let local = json!({"model_id":"sample", "server_url":"http://localhost:8000", "context_window_tokens":8192});
    fixture.write("butler.config.json", &json!({
        "system":{"butlerModel":" ", "defaultModel":"local/sample"},
        "models":{
            "local":[local, {"model_id":"sample", "server_url":"http://localhost:9000", "context_window_tokens":9000}],
            "registered":[
                {"provider_id":"openai", "auth_type":"api_key", "model_id":null, "model_ref":"openai/gpt-5.5", "credential_id":"key-one"},
                {"provider_id":"openai", "auth_type":"api_key", "model_id":"gpt-5.5", "credential_id":"missing"}
            ]
        }
    }));
    fixture.write("auth/model-provider-credentials.json", &json!({"credentials":[
        {"id":" key-one ", "provider_id":"anthropic", "auth_type":"api_key", "secret":" abcdefz ", "label":"Different provider"},
        {"id":"key-one", "provider_id":"openai", "auth_type":"api_key", "secret":"wrong-duplicate"},
        {"id":"oauth", "provider_id":"openai", "auth_type":"codex_oauth", "secret":"not-api-key"}
    ]}));
    let owner = fixture.owner(ModelConfigurationEnvironment::default());
    let read = owner.read().await.unwrap();
    assert_eq!(read.local.len(), 1);
    assert_eq!(read.local[0].context_window_tokens, 8192.0);
    assert_eq!(read.registered.len(), 1);
    assert_eq!(read.configured_default_model(), None);
    assert_eq!(read.catalog.view().default_model_ref, "local/sample");
    assert_eq!(read.catalog.view().provider_credentials.len(), 1);
    assert_eq!(
        read.catalog.view().provider_credentials[0].masked_value,
        "abc...z"
    );
    assert_eq!(read.credential_secret("key-one", "openai"), None);
    assert_eq!(
        read.credential_secret("key-one", "anthropic"),
        Some("abcdefz")
    );
    let registered = &read.catalog.view().registered_models[0];
    assert_eq!(
        registered.credential_label.as_deref(),
        Some("Different provider")
    );
    let public = serde_json::to_string(read.catalog.view()).unwrap();
    assert!(!public.contains("abcdefz"));
    assert!(!public.contains("wrong-duplicate"));
    drop(read);
    fixture.write("butler.config.json", &json!({"localModels":[{
        "model_id":"changed", "server_url":"http://localhost:8080", "context_window_tokens":16000
    }]}));
    assert_eq!(
        owner.read().await.unwrap().local[0].model_ref,
        "local/changed"
    );
    let admission = owner.snapshot(vec!["local/changed".into()]).await.unwrap();
    assert_eq!(admission.metadata[0].context_window_tokens, Some(16000.0));
    assert_eq!(admission.retry_ceiling, Some(3.0));
}

#[tokio::test]
async fn codex_probe_override_does_not_change_public_registered_endpoint() {
    let fixture = Fixture::new();
    let owner = fixture.owner(ModelConfigurationEnvironment {
        codex_base_url: Some("https://codex.example.test:443/backend-api/".into()),
        retry_attempts: Some("0x4".into()),
        ..Default::default()
    });
    let base = owner
        .registration_catalog
        .find_static_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let probe = json!({
        "provider_id":"openai", "model_id":"gpt-5.5", "model_ref":"openai/gpt-5.5", "auth_type":"codex_oauth",
        "credential_id":"ignored-for-oauth", "auth_profile":"codex_oauth",
        "api_base_url":"https://codex.example.test/backend-api", "carrier_protocol":base.image_carrier_protocol,
        "endpoint_profile_id":base.image_endpoint_profile_id, "capability_revision":base.image_capability_revision,
        "capability_digest":base.image_capability_digest, "verified_at":"2026-09-14T00:00:00.000Z"
    });
    fixture.write("butler.config.json", &json!({"models":{
        "registered":[{"provider_id":"openai", "model_id":"gpt-5.5", "auth_type":"codex_oauth"}],
        "image_probe_evidence":[probe]
    }}));
    let read = owner.read().await.unwrap();
    let model = &read.catalog.view().registered_models[0];
    assert_eq!(model.image_route_health.as_deref(), Some("healthy"));
    // Source defaultHostedProviderApiBaseUrl intentionally omits OpenAI.
    assert_eq!(model.api_base_url, None);
    assert_eq!(read.registered[0].api_base_url, None);
    let admission = owner.snapshot(vec!["openai/gpt-5.5".into()]).await.unwrap();
    assert_eq!(admission.retry_ceiling, Some(4.0));
    let mut config = read.config;
    config["models"]["image_probe_evidence"][0]["capability_digest"] = "stale-digest".into();
    fixture.write("butler.config.json", &config);
    assert_ne!(
        owner.read().await.unwrap().catalog.view().registered_models[0]
            .image_route_health
            .as_deref(),
        Some("healthy")
    );
}

#[tokio::test]
async fn absent_invalid_and_utf8_file_behavior_does_not_modify_source() {
    let fixture = Fixture::new();
    let owner = fixture.owner(ModelConfigurationEnvironment::default());
    assert!(owner.read().await.unwrap().local.is_empty());
    let path = fixture.0.join("butler.config.json");
    for bytes in [b"{broken".as_slice(), b"null", b"[]", b"\xef\xbb\xbf{}"] {
        fs::write(&path, bytes).unwrap();
        assert_eq!(owner.read().await.unwrap().config, json!({}));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::write(&path, b"{\"value\":\"\xff\"}").unwrap();
    assert_eq!(owner.read().await.unwrap().config["value"], "\u{fffd}");
}

#[test]
fn retry_environment_keeps_source_number_and_clamp_rules() {
    use super::admission::retry_attempts;
    for (input, expected) in [
        (None, 3.0),
        (Some(""), 1.0),
        (Some("  "), 1.0),
        (Some("2.9"), 2.0),
        (Some("-12"), 1.0),
        (Some("0X4"), 4.0),
        (Some("0b100"), 4.0),
        (Some("0o4"), 4.0),
        (Some("5e2"), 5.0),
        (Some("Infinity"), 3.0),
        (Some("0x"), 3.0),
        (Some("+0x4"), 3.0),
    ] {
        assert_eq!(retry_attempts(input), expected, "{input:?}");
    }
}
