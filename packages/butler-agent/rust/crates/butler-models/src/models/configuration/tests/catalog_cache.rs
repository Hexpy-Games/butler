//! Cached metadata must preserve fresh observations and secret resolution.
use super::*;

pub(super) async fn fresh_secret_with_same_mask(fixture: &Fixture, owner: &ModelConfiguration) {
    // Same masked credential metadata must still resolve the current secret.
    fixture.write(
        "auth/model-provider-credentials.json",
        &json!({"credentials":[{
            "id":"registered-key", "provider_id":"openai", "auth_type":"api_key",
            "secret":"registered-middle-secret"
        }]}),
    );
    let current = owner
        .resolve(ProviderConfigRequest {
            model_ref: "openai/gpt-5.5",
            butler_data: None,
        })
        .await
        .unwrap();
    match current.auth {
        ProviderAuth::ApiKey(value) => assert_eq!(value.as_str(), "registered-middle-secret"),
        _ => panic!("expected current API key"),
    }
}

pub(super) fn fresh_observation_time(owner: &ModelConfiguration) {
    for at in ["first", "later"] {
        let input = || ModelCatalogSnapshotInput {
            configured_local: Vec::new(),
            extra_models: Vec::new(),
            registered_models: Vec::new(),
            credential_views: Vec::new(),
            default_model_ref: None,
            generated_at: at.into(),
        };
        let cached = owner
            .catalog_cache
            .snapshot(&owner.catalog, input(), &owner.collation)
            .unwrap();
        let fresh = owner.catalog.snapshot(input(), &owner.collation).unwrap();
        assert_eq!(cached.view().generated_at, at);
        assert_eq!(
            serde_json::to_value(cached.view()).unwrap(),
            serde_json::to_value(fresh.view()).unwrap()
        );
    }
}
