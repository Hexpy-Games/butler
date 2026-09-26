use std::sync::{Arc, Weak};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::*;
use crate::locale::LocaleCollation;

fn input(registered_models: Vec<ModelProviderMetadata>) -> ModelCatalogSnapshotInput {
    ModelCatalogSnapshotInput {
        configured_local: Vec::new(),
        extra_models: Vec::new(),
        registered_models,
        credential_views: Vec::new(),
        default_model_ref: Some(DEFAULT_MODEL_REF.into()),
        generated_at: "2026-09-14T00:00:00.000Z".into(),
    }
}

fn baseline(catalog: &ModelCatalog) -> ModelCatalogSnapshot {
    catalog
        .snapshot(input(Vec::new()), &LocaleCollation::new("en-US").unwrap())
        .unwrap()
}

#[test]
fn static_source_and_default_generation_match_bun_fixture() {
    let bytes = include_bytes!("catalog/static-catalog.json");
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        catalog::STATIC_CATALOG_SOURCE_SHA256
    );
    let catalog = ModelCatalog::new().unwrap();
    let baseline = baseline(&catalog);
    assert_eq!(
        baseline.view().generation,
        "18edbcd6bf011d69a493c845a18396265b85c9ef25163ec59264b3b637417c79"
    );
    let models = baseline.list_model_metadata();
    assert_eq!(models.len(), 83);
    assert!(
        models
            .iter()
            .any(|model| model.model_ref == "openai/gpt-6-luna")
    );
    assert!(models.iter().any(|model| {
        model.model_ref == "zai-api/glm-5.3"
            && model.reasoning_efforts
                == vec![
                    ReasoningEffort::Low,
                    ReasoningEffort::High,
                    ReasoningEffort::Max,
                ]
    }));
    let snapshot = catalog
        .snapshot(input(models), &LocaleCollation::new("en-US").unwrap())
        .unwrap();
    assert_eq!(
        snapshot.view().generation,
        "18edbcd6bf011d69a493c845a18396265b85c9ef25163ec59264b3b637417c79"
    );
    assert_eq!(snapshot.view().default_model_ref, "openai/gpt-5.5");
    assert_eq!(
        snapshot.view().default_reasoning_effort,
        ReasoningEffort::Xhigh
    );
    assert_eq!(snapshot.view().providers.len(), 9);
    assert_eq!(snapshot.view().worker_model_presets.len(), 3);
    assert_eq!(
        catalog.default_worker_model_rules()[0].model,
        "openai/gpt-5.6-sol"
    );
}

#[test]
fn exact_and_declared_aliases_resolve_without_implicit_model_id() {
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = baseline(&catalog);
    assert_eq!(
        snapshot
            .find_model_metadata(Some("gpt-5.5"))
            .unwrap()
            .model_ref,
        "openai/gpt-5.5"
    );
    assert!(
        snapshot
            .find_model_metadata(Some("claude-opus-5"))
            .is_none()
    );
    assert_eq!(parse_model_ref("o3").canonical_ref, "openai/o3");
    assert_eq!(parse_model_ref("unknown").canonical_ref, "custom/unknown");

    let mut first = snapshot
        .find_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let mut second = first.clone();
    first.model_ref = "openai/one".into();
    second.model_ref = "openai/two".into();
    first.aliases = Some(vec!["collision".into()]);
    second.aliases = Some(vec!["collision".into()]);
    let mut custom = input(Vec::new());
    custom.extra_models = vec![first, second];
    let snapshot = catalog
        .snapshot(custom, &LocaleCollation::new("en-US").unwrap())
        .unwrap();
    assert!(snapshot.find_model_metadata(Some("collision")).is_none());
}

#[test]
fn list_concatenates_while_lookup_overwrites_same_ref() {
    let catalog = ModelCatalog::new().unwrap();
    let base = baseline(&catalog);
    let mut replacement = base.find_model_metadata(Some(DEFAULT_MODEL_REF)).unwrap();
    replacement.display_name = "Configured replacement".into();
    let mut custom = input(Vec::new());
    custom.extra_models.push(replacement);
    let snapshot = catalog
        .snapshot(custom, &LocaleCollation::new("en-US").unwrap())
        .unwrap();
    assert_eq!(
        snapshot
            .list_model_metadata()
            .iter()
            .filter(|model| model.model_ref == DEFAULT_MODEL_REF)
            .count(),
        2
    );
    assert!(
        snapshot
            .find_model_metadata(Some(DEFAULT_MODEL_REF))
            .is_none()
    );
    assert_eq!(
        snapshot
            .resolve_model_metadata(Some(DEFAULT_MODEL_REF))
            .display_name,
        "Configured replacement"
    );
}

#[test]
fn local_metadata_and_provider_family_preserve_source_rules() {
    let raw = json!({"model_id":"qwen3.8-local.gguf","display_name":"  Qwen Local  ","server_url":"localhost:8080/",
        "context_window_tokens":32768,"max_output_tokens":4096,"reasoning_budget_ratio":0.25,"platform":"llama_cpp","source":"manual"});
    let config = normalize_local_model_config(&raw, "2026-09-14T00:00:00.000Z").unwrap();
    let metadata = ModelProviderMetadata::from(&config);
    assert_eq!(metadata.model_ref, "local/qwen3.8-local.gguf");
    assert_eq!(
        metadata.reasoning_efforts,
        vec![
            ReasoningEffort::None,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::Xhigh
        ]
    );
    assert_eq!(metadata.local_reasoning_budget_ratio, None);
    let unicode = json!({"model_id":"unicode","server_url":"https://bücher.example:443/a b/?x=1#z",
        "context_window_tokens":16384});
    let normalized = normalize_local_model_config(&unicode, "now").unwrap();
    assert_eq!(normalized.server_url, "https://xn--bcher-kva.example/a%20b");
    assert_eq!(
        normalized.api_base_url,
        "https://xn--bcher-kva.example/a%20b/v1"
    );
    let credentialed = json!({"model_id":"bad","server_url":"https://u:p@example.com/v1",
        "context_window_tokens":16384});
    assert!(normalize_local_model_config(&credentialed, "now").is_none());

    let catalog = ModelCatalog::new().unwrap();
    let snapshot = baseline(&catalog);
    let zai = snapshot.find_model_metadata(Some("zai/glm-5.2")).unwrap();
    let api = snapshot
        .find_model_metadata(Some("zai-api/glm-5.2"))
        .unwrap();
    assert_eq!(model_identity_key(&zai), model_identity_key(&api));
}

#[test]
fn tokenizer_is_lazy_literal_and_released_with_owner() {
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let weak: Weak<ModelCatalog> = Arc::downgrade(&catalog);
    let snapshot = baseline(&catalog);
    assert!(!catalog.tokenizer_loaded());
    let google = catalog
        .estimate_tokens(
            &snapshot,
            TokenEstimateInput::Text("😀abc"),
            Some("google/gemini-3.5-flash"),
        )
        .unwrap();
    assert_eq!(google.tokens, 2.0);
    assert!(!catalog.tokenizer_loaded());
    for (text, expected) in [("hello", 1.0), ("<|endoftext|>", 7.0), ("😀astral", 3.0)] {
        assert_eq!(
            catalog
                .estimate_tokens(
                    &snapshot,
                    TokenEstimateInput::Text(text),
                    Some(DEFAULT_MODEL_REF)
                )
                .unwrap()
                .tokens,
            expected
        );
    }
    assert!(catalog.tokenizer_loaded());
    drop(snapshot);
    drop(catalog);
    assert!(weak.upgrade().is_none());
}

#[test]
fn supplied_registered_config_normalizes_without_secrets_or_io() {
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = baseline(&catalog);
    let raw: Value = json!({"provider_id":"openai","model_id":"gpt-5.5","display_name":" My model ",
        "auth_type":"api_key","credential_id":" cred_1 ","api_base_url":"HTTPS://API.EXAMPLE.COM:443/v1/?secret=no#x"});
    let normalized =
        normalize_registered_hosted_model(&raw, &snapshot, "2026-09-14T00:00:00.000Z").unwrap();
    assert_eq!(normalized.credential_id.as_deref(), Some("cred_1"));
    assert_eq!(
        normalized.api_base_url.as_deref(),
        Some("https://api.example.com/v1")
    );
    assert!(
        !serde_json::to_string(&normalized)
            .unwrap()
            .contains("secret")
    );
    let null_id = json!({"provider_id":"openai","model_id":null,"model_ref":"openai/gpt-5.5",
        "auth_type":"api_key","credential_id":"cred_1"});
    assert_eq!(
        normalize_registered_hosted_model(&null_id, &snapshot, "now")
            .unwrap()
            .model_ref,
        "openai/gpt-5.5"
    );
    let unicode = Value::String("HTTPS://BÜCHER.example:443/a b/?x=1#z".into());
    assert_eq!(
        normalize_hosted_api_base_url(Some(&unicode)).as_deref(),
        Some("https://xn--bcher-kva.example/a%20b")
    );
    let credentials = Value::String("https://u:p@EXAMPLE.com:443/v1/".into());
    assert_eq!(
        normalize_hosted_api_base_url(Some(&credentials)).as_deref(),
        Some("https://u:p@example.com/v1")
    );

    let astral = format!("{}{}", "😀".repeat(30), "a".repeat(30));
    let raw = json!({"provider_id":"openai","model_id":"gpt-5.5","display_name":astral,
        "auth_type":"api_key","credential_id":"cred_1"});
    let normalized = normalize_registered_hosted_model(&raw, &snapshot, "now").unwrap();
    assert_eq!(
        normalized.display_name,
        format!("{}{}", "😀".repeat(30), "a".repeat(19))
    );

    let trailing = format!("{}{} tail", "😀".repeat(30), "a".repeat(18));
    let raw = json!({"provider_id":"openai","model_id":"gpt-5.5","display_name":trailing,
        "auth_type":"api_key","credential_id":"cred_1"});
    let normalized = normalize_registered_hosted_model(&raw, &snapshot, "now").unwrap();
    assert_eq!(
        normalized.display_name,
        format!("{}{}", "😀".repeat(30), "a".repeat(18))
    );
}
