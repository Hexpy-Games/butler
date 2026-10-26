//! Offline wire regressions, invoked by the evaluation self-test.
use butler_e2e::e2e::{config::LiveProvider, provider::delegation_eval::wire};
use serde_json::json;
use std::fmt::Write;

pub(super) fn anthropic_default() {
    let provider = LiveProvider::from_vars(&|key| match key {
        "BUTLER_E2E_PROVIDER" => Some("anthropic".into()),
        "BUTLER_E2E_MODEL" => Some("anthropic/claude-sonnet-5-5".into()),
        "BUTLER_E2E_API_KEY_ENV" => Some("EVAL_DUMMY_KEY".into()),
        "EVAL_DUMMY_KEY" => Some("dummy".into()),
        _ => None,
    })
    .unwrap();
    assert_eq!(
        provider.upstream_default(),
        Some("https://api.anthropic.com/v1")
    );
}

pub(super) fn responses_output_items() {
    let item = json!({"type":"function_call","id":"fc_test","call_id":"call_test",
        "namespace":"butler","name":"butler.delegate_to_steward","arguments":"{}"});
    let final_body = json!({"status":"completed","output":[item],"usage":{"output_tokens":41}});
    let parsed = wire::parse(final_body.to_string().as_bytes());
    assert_eq!(parsed["calls"][0]["name"], "delegate_to_steward");
    assert_eq!(
        parsed["first_output_item"],
        json!({"type":"function_call",
        "name":"butler.delegate_to_steward","namespace":"butler"})
    );
    let events = [
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"status":"completed","output":[],"usage":{"output_tokens":41}}}),
    ];
    let mut body = String::new();
    for event in events {
        write!(body, "data: {event}\n\n").unwrap();
    }
    let parsed = wire::parse(body.as_bytes());
    assert_eq!(parsed["calls"].as_array().unwrap().len(), 1);
    assert_eq!(parsed["calls"][0]["name"], "delegate_to_steward");
    assert_eq!(parsed["complete"], true);
}

pub(super) fn anthropic_blocks() {
    let block = json!({"type":"tool_use","id":"toolu_test","name":"delegate_to_steward","input":{"request":"test"}});
    let parsed = wire::parse(
        json!({"content":[block],"stop_reason":"tool_use"})
            .to_string()
            .as_bytes(),
    );
    assert_eq!(parsed["calls"][0]["name"], "delegate_to_steward");
    assert_eq!(parsed["complete"], true);
}

pub(super) async fn forwarding() -> Result<(), butler_e2e::e2e::HarnessError> {
    use butler_e2e::e2e::{provider::Provider, scenario::Setup};
    use std::sync::atomic::Ordering;
    let provider = LiveProvider::from_vars(&|key| match key {
        "BUTLER_E2E_PROVIDER" => Some("anthropic".into()),
        "BUTLER_E2E_MODEL" => Some("anthropic/claude-sonnet-5-5".into()),
        "BUTLER_E2E_API_KEY_ENV" => Some("BUTLER_E2E_DELEGATION_DUMMY_KEY".into()),
        "BUTLER_E2E_DELEGATION_DUMMY_KEY" => Some("dummy".into()),
        _ => None,
    })
    .unwrap();
    assert_eq!(
        super::local::upstream(Some(&provider), None)?,
        "https://api.anthropic.com/v1"
    );
    let mut unsupported = provider.clone();
    unsupported.provider = "unsupported".into();
    assert!(
        super::local::upstream(Some(&unsupported), None)
            .unwrap_err()
            .to_string()
            .contains("no upstream")
    );
    let case = json!({"label":"direct"});
    let fake = super::fake::Upstream::start(true, &case).await?;
    let (proxy, eval) = Provider::delegation_evaluation(fake.base.clone(), false, 1).await?;
    let mut scenario = super::local::live_setup(
        Setup::new("DELEGATION-ANTHROPIC-OFFLINE")?,
        provider,
        &proxy.base_url,
    )
    .start()
    .await?;
    let endpoint = scenario
        .agent
        .launch
        .env
        .iter()
        .find(|(key, _)| key == "BUTLER_ANTHROPIC_CACHE_VERIFIED_ENDPOINT")
        .unwrap();
    assert_eq!(endpoint.1, format!("{}/messages", proxy.base_url));
    super::fixture::register_model(&scenario, &proxy.base_url).await?;
    eval.armed.store(true, Ordering::SeqCst);
    let chat = super::fixture::chat(&scenario).await?;
    let (_, turn) = scenario.turn(&chat, "Say thanks.").await?;
    let samples = eval.snapshot();
    assert!(
        !samples.is_empty(),
        "Anthropic turn without upstream sample: {turn}"
    );
    fake.verify(&samples);
    assert!(
        fake.header_names.lock().unwrap()[0]
            .iter()
            .any(|name| name == "x-api-key")
    );
    assert!(
        samples[0]["request"].to_string().contains("\"ttl\":\"1h\""),
        "verified cache serialization missing"
    );
    scenario.sandbox.mark_success();
    Ok(())
}

pub(super) async fn round_limit() -> Result<(), butler_e2e::e2e::HarnessError> {
    use butler_e2e::e2e::provider::Provider;
    use std::sync::atomic::Ordering;
    let case = json!({"label":"delegate","request":"Do the work","checks":["Done"]});
    let fake = super::fake::Upstream::start(false, &case).await?;
    let (proxy, eval) = Provider::delegation_evaluation(fake.base.clone(), true, 2).await?;
    *eval.delegation.lock().unwrap() = super::local::parent_script(&case, "old").into();
    let client = butler_e2e::e2e::gateway::Gateway::new(proxy.base_url.clone(), String::new());
    let body = json!({"model":"gpt-6-luna","tools":[{"type":"function","name":"write_file"}],
        "input":[{"role":"user","content":"Parent request"}]});
    for expected in [
        "start_work",
        "replace_work_plan",
        "record_work_review",
        "delegate_to_steward",
    ] {
        let reply = client.post("/v1/responses", body.clone()).await?;
        assert_eq!(
            wire::parse(reply.text.as_bytes())["calls"][0]["name"],
            expected
        );
    }
    assert_eq!(
        eval.upstream_rounds(),
        0,
        "local Butler answers consumed budget"
    );
    for role in ["steward", "worker"] {
        let mut body = body.clone();
        body["input"][0]["content"] = json!(format!("role: {role}\nDo work"));
        assert_eq!(client.post("/v1/responses", body).await?.status, 200);
    }
    let mut child = body.clone();
    child["input"][0]["content"] = json!("role: steward\nContinue work");
    assert_eq!(client.post("/v1/responses", child).await?.status, 429);
    assert!(eval.limited.load(Ordering::SeqCst));
    assert_eq!(eval.upstream_rounds(), 2);
    fake.verify(&eval.snapshot());
    assert_eq!(eval.snapshot().len(), 2);
    let mut row = json!({"samples":eval.snapshot(),"round_limit":true,"timed_out":false,"error":null,"terminal_result":false});
    super::run::diagnostics(&mut row);
    assert_eq!(row["outcome"], "limit_hit");
    assert!(row["invalid_reason"].is_null());
    Ok(())
}
