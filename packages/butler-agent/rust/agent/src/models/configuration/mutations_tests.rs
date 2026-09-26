use std::{fs, path::PathBuf, sync::Arc};

use serde_json::Value;

use super::*;
use crate::{
    locale::LocaleCollation,
    models::{LocalModelSource, ModelCatalog, ProviderAuthMethod},
};

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
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-p2c-mutations-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn owner(&self) -> ModelConfiguration {
        self.owner_with(Arc::new(crate::configuration::ConfigurationWrites::new()))
    }
    fn owner_with(
        &self,
        writes: Arc<crate::configuration::ConfigurationWrites>,
    ) -> ModelConfiguration {
        ModelConfiguration::new(
            self.0.clone(),
            ModelConfigurationEnvironment {
                ..Default::default()
            },
            Arc::new(Clock),
            Arc::new(ModelCatalog::new().unwrap()),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
            crate::models::provider_http_client().unwrap(),
            writes,
        )
        .unwrap()
    }
    fn config(&self) -> Value {
        serde_json::from_slice(&fs::read(self.0.join("butler.config.json")).unwrap()).unwrap()
    }
}

#[tokio::test]
async fn concurrent_distinct_registrations_share_the_full_file_write_sequence() {
    let fixture = Fixture::new();
    let writes = Arc::new(crate::configuration::ConfigurationWrites::new());
    let first_owner = fixture.owner_with(Arc::clone(&writes));
    let second_owner = fixture.owner_with(writes);
    let first = LocalModelMutation {
        server_url: "http://127.0.0.1:8081".into(),
        api_key: None,
        platform: LocalModelPlatform::Custom,
        model_id: "first".into(),
        display_name: None,
        context_window_tokens: 4_096.0,
        max_output_tokens: None,
        reasoning_budget_ratio: None,
        source: LocalModelSource::Manual,
    };
    let second = LocalModelMutation {
        server_url: "http://127.0.0.1:8082".into(),
        api_key: None,
        platform: LocalModelPlatform::Custom,
        model_id: "second".into(),
        display_name: None,
        context_window_tokens: 8_192.0,
        max_output_tokens: None,
        reasoning_budget_ratio: None,
        source: LocalModelSource::Manual,
    };
    let (first_result, second_result) = tokio::join!(
        first_owner.upsert_local_model(&first, None),
        second_owner.upsert_local_model(&second, None),
    );
    first_result.unwrap();
    second_result.unwrap();
    let config = fixture.config();
    let mut model_refs = config
        .pointer("/models/local")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter_map(|model| model.get("model_ref").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    model_refs.sort();
    assert_eq!(model_refs, ["local/first", "local/second"]);
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn local_and_hosted_mutations_preserve_config_and_exact_image_route_evidence() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("butler.config.json"),
        br#"{"unrelated":{"kept":true},"models":{"other":"kept"}}"#,
    )
    .unwrap();
    let owner = fixture.owner();
    let local = LocalModelMutation {
        server_url: "127.0.0.1:11434".into(),
        api_key: None,
        platform: LocalModelPlatform::Ollama,
        model_id: "fixture.gguf".into(),
        display_name: None,
        context_window_tokens: 8_192.0,
        max_output_tokens: Some(2_048.0),
        reasoning_budget_ratio: Some(0.25),
        source: LocalModelSource::Manual,
    };
    let stored = owner.upsert_local_model(&local, None).await.unwrap();
    assert_eq!(stored.api_base_url, "http://127.0.0.1:11434/v1");
    assert_eq!(
        fixture.config().pointer("/unrelated/kept"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        fixture.config().pointer("/models/other"),
        Some(&Value::String("kept".into()))
    );

    let hosted = owner
        .register_hosted_model(
            &HostedModelMutation {
                provider_id: "openai".into(),
                model_id: "gpt-5.5".into(),
                auth_type: ProviderAuthMethod::ApiKey,
                credential_id: None,
                api_key: Some(" fixture-secret ".into()),
                credential_label: Some("Fixture".into()),
                display_name: None,
                api_base_url: None,
                auth_profile: None,
            },
            None,
        )
        .await
        .unwrap();
    assert!(
        hosted
            .credential_id
            .as_deref()
            .unwrap()
            .starts_with("cred_")
    );
    assert_eq!(
        owner
            .delete_hosted_model("gpt-5.5", None)
            .await
            .unwrap()
            .model_ref,
        "openai/gpt-5.5"
    );
    assert_eq!(
        owner
            .delete_local_model("fixture.gguf", None)
            .await
            .unwrap()
            .model_ref,
        "local/fixture.gguf"
    );
    assert_eq!(
        fixture.config().pointer("/unrelated/kept"),
        Some(&Value::Bool(true))
    );
}

#[tokio::test]
async fn update_local_returns_previous_ref_and_owned_temp_files_are_cleaned() {
    let fixture = Fixture::new();
    let owner = fixture.owner();
    let input = LocalModelMutation {
        server_url: "http://127.0.0.1:8080".into(),
        api_key: None,
        platform: LocalModelPlatform::Custom,
        model_id: "before".into(),
        display_name: None,
        context_window_tokens: 4_096.0,
        max_output_tokens: None,
        reasoning_budget_ratio: None,
        source: LocalModelSource::Manual,
    };
    owner.upsert_local_model(&input, None).await.unwrap();
    let replacement = LocalModelMutation {
        model_id: "after".into(),
        ..input
    };
    let (stored, previous) = owner
        .update_local_model("before", &replacement, None)
        .await
        .unwrap();
    assert_eq!(previous, "local/before");
    assert_eq!(stored.model_ref, "local/after");
    let temp_files = fs::read_dir(&fixture.0)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(temp_files, 0);
}

#[tokio::test]
async fn custom_model_credentials_are_endpoint_scoped_private_and_clearable() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("butler.config.json"),
        br#"{"system":{"defaultModel":"openai/gpt-5.5"},"models":{"other":"kept"}}"#,
    )
    .unwrap();
    let owner = fixture.owner();
    let first = LocalModelMutation {
        server_url: "http://127.0.0.1:8081/proxy/v1/".into(),
        api_key: Some(" private-key ".into()),
        platform: LocalModelPlatform::Custom,
        model_id: "org/model.gguf".into(),
        display_name: None,
        context_window_tokens: 8_192.0,
        max_output_tokens: None,
        reasoning_budget_ratio: None,
        source: LocalModelSource::Manual,
    };
    let registered = owner.upsert_local_model(&first, None).await.unwrap();
    assert_eq!(registered.model_id, "org/model.gguf");
    assert_eq!(registered.model_ref, "local/org-model.gguf");
    assert_eq!(registered.provider_label, "Custom");
    assert_eq!(registered.api_base_url, "http://127.0.0.1:8081/proxy/v1");

    let config = fixture.config();
    assert_eq!(
        config
            .pointer("/system/defaultModel")
            .and_then(Value::as_str),
        Some("openai/gpt-5.5")
    );
    assert_eq!(
        config.pointer("/models/other").and_then(Value::as_str),
        Some("kept")
    );
    assert_eq!(config.pointer("/models/local/0/api_key"), None);
    assert_eq!(
        config
            .pointer("/models/local/0/model_id")
            .and_then(Value::as_str),
        Some("org/model.gguf")
    );
    let secret_path = fixture.0.join("auth/custom-model-credentials.json");
    let secrets: Value = serde_json::from_slice(&fs::read(&secret_path).unwrap()).unwrap();
    assert_eq!(secrets["local/org-model.gguf"], "private-key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let reuse = LocalModelMutation {
        api_key: None,
        ..first.clone()
    };
    assert_eq!(
        owner
            .upsert_local_model(&reuse, None)
            .await
            .unwrap()
            .model_ref,
        registered.model_ref
    );
    let secrets: Value = serde_json::from_slice(&fs::read(&secret_path).unwrap()).unwrap();
    assert_eq!(secrets["local/org-model.gguf"], "private-key");

    let second = LocalModelMutation {
        server_url: "http://127.0.0.1:8082/proxy/v1".into(),
        api_key: None,
        ..first
    };
    let second_model = owner.upsert_local_model(&second, None).await.unwrap();
    assert_ne!(second_model.model_ref, registered.model_ref);
    assert!(second_model.model_ref.starts_with("local/org-model.gguf-"));
    let secrets: Value = serde_json::from_slice(&fs::read(&secret_path).unwrap()).unwrap();
    assert_eq!(secrets["local/org-model.gguf"], "private-key");
    assert!(secrets.get(&second_model.model_ref).is_none());

    let clear = LocalModelMutation {
        server_url: "http://127.0.0.1:8081/proxy/v1".into(),
        api_key: Some(String::new()),
        platform: LocalModelPlatform::Custom,
        model_id: registered.model_id.clone(),
        display_name: None,
        context_window_tokens: 8_192.0,
        max_output_tokens: None,
        reasoning_budget_ratio: None,
        source: LocalModelSource::Manual,
    };
    owner.upsert_local_model(&clear, None).await.unwrap();
    let secrets: Value = serde_json::from_slice(&fs::read(&secret_path).unwrap()).unwrap();
    assert!(secrets.get("local/org-model.gguf").is_none());
}
