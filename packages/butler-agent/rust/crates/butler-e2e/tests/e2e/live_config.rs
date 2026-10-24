//! The live selection comes only from `BUTLER_E2E_*` variables: any catalog
//! API-key provider resolves, and nothing defaults to one provider.
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::config::{Credential, LiveProvider, ModelChoice};
use std::collections::HashMap;

fn resolve(vars: &[(&str, &str)]) -> Result<LiveProvider, String> {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    LiveProvider::from_vars(&|key| vars.get(key).cloned())
}

#[test]
fn live_selection_resolves_an_api_key_provider_through_the_catalog() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider = resolve(&[
        ("BUTLER_E2E_PROVIDER", "zai-api"),
        ("BUTLER_E2E_MODEL", "zai-api/glm-5.3-flash@low"),
        ("BUTLER_E2E_API_KEY_ENV", "LIVE_KEY"),
        ("LIVE_KEY", "placeholder"),
    ])
    .unwrap();
    let choice = ModelChoice::parse("zai-api/glm-5.3-flash@low").unwrap();
    assert_eq!(provider.choice, choice);
    assert_eq!(provider.matrix, vec![choice]);
    assert!(matches!(
        provider.credential,
        Some(Credential::ApiKey { ref env_var }) if env_var == "LIVE_KEY"
    ));
    assert_eq!(
        provider.upstream_default(),
        butler_models::models::default_hosted_provider_api_base_url("zai-api")
    );
    assert_eq!(provider.base_url_env(), Some("BUTLER_ZAI_API_BASE_URL"));
    // The Coding Plan provider takes the same API-key route.
    let plan = resolve(&[
        ("BUTLER_E2E_PROVIDER", "zai"),
        ("BUTLER_E2E_MODEL", "zai/glm-5.3-flash@max"),
        ("ZAI_API_KEY", "placeholder"),
    ])
    .unwrap();
    assert!(matches!(
        plan.credential,
        Some(Credential::ApiKey { ref env_var }) if env_var == "ZAI_API_KEY"
    ));
    assert_eq!(plan.base_url_env(), Some("BUTLER_ZAI_BASE_URL"));
    Ok(())
}

#[test]
fn live_selection_names_the_missing_variable_instead_of_a_default() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let unset = |vars: &[(&str, &str)]| resolve(vars).err().unwrap();
    assert_eq!(unset(&[]), "BUTLER_E2E_PROVIDER is unset");
    assert_eq!(
        unset(&[("BUTLER_E2E_PROVIDER", "zai-api")]),
        "BUTLER_E2E_MODEL is unset"
    );
    let keyless = resolve(&[
        ("BUTLER_E2E_PROVIDER", "zai-api"),
        ("BUTLER_E2E_MODEL", "zai-api/glm-5.3-flash"),
    ])
    .unwrap();
    assert!(keyless.credential.is_none());
    Ok(())
}
