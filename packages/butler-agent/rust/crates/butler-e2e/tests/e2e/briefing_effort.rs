//! A stored memory-model effort the model no longer lists still yields a briefing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    provider::title_response,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::path::Path;

const NOW: &str = "2026-10-02T04:01:00.000Z";
const NEXT_DAY: &str = "2026-10-03T04:01:00.000Z";

pub(super) fn briefing_task(request: &Value) -> bool {
    let raw = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str())
        .unwrap_or("");
    serde_json::from_str::<Value>(raw).is_ok_and(|task| {
        matches!(
            task["task"].as_str(),
            Some("general_new_chat_briefing" | "project_new_chat_briefing")
        )
    })
}

pub(super) fn briefing(request: &Value) -> Option<ResponseRecord> {
    if !briefing_task(request) {
        return None;
    }
    let content = json!({"moment":"Today","title":"Welcome","description":"Topics to discuss",
        "suggestions":(0..4).map(|n|json!({"id":format!("topic-{n}"),"title":format!("Topic {n}"),
            "description":"Explore","text":"Discuss this topic","source_kind":"current_interest"}))
            .collect::<Vec<_>>(),
        "title_variants":{"morning":"Welcome","afternoon":"Welcome","evening":"Welcome","night":"Welcome"}});
    Some(title_response(&content.to_string()))
}

/// The first selectable model of the stub's provider whose catalog entry
/// omits an effort another cataloged model offers: (model, omitted, default).
async fn unlisted_effort(s: &Scenario) -> Result<(Value, String, String), HarnessError> {
    let catalog = s.gw.get("/model-catalog").await?.data().clone();
    let models = catalog["models"].as_array().unwrap();
    let mut efforts = Vec::<String>::new();
    for effort in models
        .iter()
        .flat_map(|model| model["reasoning_efforts"].as_array().unwrap())
    {
        let effort = effort.as_str().unwrap().to_owned();
        if !efforts.contains(&effort) {
            efforts.push(effort);
        }
    }
    let provider = s.model.model.split_once('/').unwrap().0;
    models
        .iter()
        .filter(|model| {
            model["provider_id"] == provider
                && model["runtime_supported"] == true
                && model["enabled"] != false
                && model["registered"] != false
        })
        .find_map(|model| {
            let listed = model["reasoning_efforts"].as_array().unwrap();
            let omitted = efforts
                .iter()
                .find(|effort| !listed.iter().any(|value| value == effort.as_str()))?;
            let default = model["default_reasoning_effort"].as_str().unwrap();
            Some((model.clone(), omitted.clone(), default.to_owned()))
        })
        .ok_or_else(|| {
            butler_e2e::e2e::harness_error(format!("no {provider} model omits an effort"))
        })
}

/// Runs the daily consolidation cycle on the next day through a restart.
async fn next_daily_cycle(s: &mut Scenario) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_E2E_APP_NOW", NEXT_DAY);
    for job in ["session-sync", "consolidation-cycle"] {
        std::fs::remove_file(s.sandbox.data.join(format!("state/scheduler/{job}.json")))?;
    }
    super::memory_fixture::arm_consolidation(&s.sandbox.data, NOW)?;
    s.gw = s.agent.start_again().await?;
    let marker = s
        .sandbox
        .data
        .join("state/scheduler/consolidation-cycle.json");
    let day = &NEXT_DAY[..10];
    until(|| {
        std::fs::read(&marker)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|state| state["lastRunDate"] == day)
    })
    .await;
    let state: Value = serde_json::from_slice(&std::fs::read(&marker)?)?;
    assert_eq!(state["status"], "ok", "{state}");
    Ok(())
}

// A watchdog around the durable cycle marker, not a latency assertion.
async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while !ready() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("daily consolidation did not publish its completion marker");
}

pub(super) fn general_briefing(data: &Path) -> Option<Value> {
    let root = data.join("cognition/consolidation/briefings");
    std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .find_map(|day| std::fs::read(day.path().join("general.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

#[tokio::test]
async fn briefing_with_unlisted_effort_uses_the_model_default() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let mut s = Setup::new("BRIEFING-EFFORT")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_APP_NOW", NOW)
        .start()
        .await?;
    s.provider()?.set_chat_responder(briefing);
    let (model, omitted, default) = unlisted_effort(&s).await?;
    let model_ref = model["model_ref"].as_str().unwrap();
    // Settings keep the stored effort; only the runtime admits it per model.
    let reply =
        s.gw.patch(
            "/settings",
            json!({"consolidation_model":model_ref,"consolidation_reasoning_effort":omitted}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    next_daily_cycle(&mut s).await?;
    let stored = general_briefing(&s.sandbox.data)
        .unwrap_or_else(|| panic!("{model_ref} at unlisted {omitted} produced no briefing"));
    assert_eq!(stored["source"]["model_ref"], model_ref, "{stored}");
    assert_eq!(stored["source"]["reasoning_effort"], default, "{stored}");
    let sent: Vec<Value> = s
        .provider()?
        .requests()
        .into_iter()
        .filter(briefing_task)
        .collect();
    assert!(!sent.is_empty(), "no briefing request reached the provider");
    for request in &sent {
        assert_eq!(request["model"], model["model_id"], "{request}");
        assert_eq!(
            request["reasoning"]["effort"],
            default.as_str(),
            "{request}"
        );
    }
    eprintln!(
        "BRIEFING-EFFORT model={model_ref} stored={omitted} sent={default} requests={}",
        sent.len()
    );
    s.finish().await
}

#[tokio::test]
async fn truncated_prompt_is_not_stored_as_briefing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let response =
        briefing(&json!({"input":json!({"task":"general_new_chat_briefing"}).to_string()}))
            .unwrap();
    let last = &response.chunks.last().unwrap().text;
    let data = last
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let value: Value = serde_json::from_str(data)?;
    let text = value["response"]["output"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    let (mut s, stub, server) = super::anthropic_output_limit::setup_briefing(text).await?;
    next_daily_cycle(&mut s).await?;
    assert!(
        !stub.requests.lock().unwrap().is_empty(),
        "no briefing request: {}",
        s.agent.logs()
    );
    assert!(
        general_briefing(&s.sandbox.data).is_none(),
        "truncated briefing stored; {}",
        s.agent.logs()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
