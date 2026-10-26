//! Local parent scripts and live routing; no model calls are made here.
use butler_e2e::e2e::{
    HarnessError,
    config::{LiveProvider, base_path},
    provider::delegation_eval::wire,
    scenario::Setup,
};
use serde_json::{Value, json};

pub(super) fn upstream(
    live: Option<&LiveProvider>,
    fake: Option<&str>,
) -> Result<String, HarnessError> {
    match live {
        Some(provider) => provider
            .base_url
            .clone()
            .or_else(|| provider.upstream_default().map(str::to_owned))
            .ok_or_else(|| {
                HarnessError(format!(
                    "delegation evaluation: no upstream for provider {}",
                    provider.provider
                ))
            }),
        None => fake
            .map(str::to_owned)
            .ok_or_else(|| HarnessError("delegation evaluation: no offline upstream".into())),
    }
}

pub(super) fn live_setup(setup: Setup, mut provider: LiveProvider, proxy: &str) -> Setup {
    provider.base_url = Some(format!("{proxy}{}", base_path(&provider.provider)));
    let anthropic = provider.provider == "anthropic";
    let configured = setup.live(provider);
    if anthropic {
        configured.env(
            "BUTLER_ANTHROPIC_CACHE_VERIFIED_ENDPOINT",
            cache_endpoint(proxy),
        )
    } else {
        configured
    }
}

pub(super) fn cache_endpoint(proxy: &str) -> String {
    format!("{proxy}/messages")
}

pub(super) fn parent_script(case: &Value, variant: &str) -> Vec<Value> {
    let request = &case["request"];
    let checks = &case["checks"];
    let mut calls = if variant == "old" {
        vec![
            wire::call("start_work", &json!({"objective":request})),
            wire::call(
                "replace_work_plan",
                &json!({"objective":request,"execution_mode":"steward",
                "actions":[{"action_key":"deliver","description":request}],"checks":checks}),
            ),
            wire::call(
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept","summary":"Ready for Steward"}),
            ),
            wire::call("delegate_to_steward", &json!({"request":request})),
        ]
    } else {
        vec![wire::call(
            "delegate_to_steward",
            &json!({"request":request,"checks":checks}),
        )]
    };
    for (index, call) in calls.iter_mut().enumerate() {
        call["id"] = json!(format!("fc_parent_{index}"));
        call["call_id"] = json!(format!("call_parent_{index}"));
    }
    calls
}
