use serde_json::{Value, json};

use super::*;
use butler_core::locale::LocaleCollation;

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
