//! Every schedule run, including Run now, requires its switch AND a site grant.
use super::super::host::{admin, attach, snapshot, tab};
use super::{
    SITE, URL,
    support::{ASK, cassette, delivered},
};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) async fn create(
    s: &Scenario,
    scheduled: bool,
    signin: bool,
    payment: bool,
) -> Result<String, HarnessError> {
    if scheduled {
        // The fixture clock is midnight. Exercise the browser gates outside
        // the quiet-hours policy introduced on main.
        s.patch_settings(
            json!({"quiet_hours_start":"01:00","quiet_hours_end":"02:00"}),
            "schedule browser quiet hours",
        )
        .await?;
    }
    let result =
        s.gw.post(
            "/automations",
            json!({"title":"Account check", "prompt_body":ASK,
        "target_session_id":"general", "interval_seconds":3600, "access_mode":"full_access",
        "schedule_type":if scheduled {"once"} else {"interval"},
        "run_at":if scheduled {Some("2000-01-01T00:00:00Z")} else {None},
        "browser_signin":signin,"browser_payment":payment}),
        )
        .await?;
    assert_eq!(result.status, 201, "{}", result.text);
    assert_eq!(result.data()["automation"]["browser_signin"], signin);
    assert_eq!(result.data()["automation"]["browser_payment"], payment);
    Ok(result.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}

pub(super) async fn run(s: &Scenario, id: &str, scheduled: bool) -> Result<Value, HarnessError> {
    if !scheduled {
        let started =
            s.gw.post(&format!("/automations/{id}/run"), json!({}))
                .await?;
        assert_eq!(started.status, 202, "{}", started.text);
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let runs = s.gw.get(&format!("/automations/{id}/runs")).await?;
        if let Some(run) = runs.data()["runs"].as_array().and_then(|runs| runs.first())
            && let Some(turn) = run["turn_id"].as_str()
        {
            delivered(s, "general", turn).await?;
            let refreshed = s.gw.get(&format!("/automations/{id}/runs")).await?;
            return Ok(refreshed.data()["runs"][0].clone());
        }
        assert!(
            Instant::now() < deadline,
            "run never started: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) async fn attention(
    s: &Scenario,
    run: &Value,
    code: Option<&str>,
) -> Result<(), HarnessError> {
    assert_eq!(run["safe_error_code"].as_str(), code, "{run}");
    let events = s.gw.events_since(0).await?;
    let matching: Vec<_> = events
        .iter()
        .filter(|event| {
            event["type"] == "automation.run"
                && event["payload"]["automation_id"] == run["automation_id"]
                && event["payload"]["safe_error_code"].as_str() == code
                && event["payload"].get("tainted").is_some()
        })
        .collect();
    assert_eq!(
        matching.len(),
        usize::from(code.is_some()),
        "run={run}, attention={matching:?}"
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let count: i64 = db.query_row("SELECT COUNT(*) FROM btcc_authority_requests", [], |row| {
        row.get(0)
    })?;
    assert_eq!(count, 0, "schedule browser steps never wait for cards");
    Ok(())
}

#[tokio::test]
async fn signin_switch_and_existing_grant_gate_scheduled_and_run_now_steps()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let script = cassette(vec![
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_tabs"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_open","arguments":{"url":URL,"signed_in":true}}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"identity"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_tabs","arguments":{}}),
        ),
    ])?;
    let s = Setup::new("SCHEDULE-SIGNIN-SWITCH")?
        .stub_cassette(script)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(&s, Arc::new(|_frame: Value| Box::pin(async move {
        json!({"status":"ok","tab":"identity","url":URL,"obs":"o1","text":"Account","tabs":[],"profile":"signed_in"})
    }))).await?;
    snapshot(
        &admin,
        json!([tab("identity", "conversation:general", URL, "agent")]),
    )
    .await?;
    for scheduled in [false, true] {
        for (on, granted, code) in [
            (false, true, Some("schedule_signin_off")),
            (true, true, None),
            (true, false, Some("schedule_permission_required")),
        ] {
            let response = admin
                .send(
                    Method::POST,
                    "/security/signins/site",
                    Some(json!({"site":SITE,"all_conversations":granted})),
                    &[],
                )
                .await?;
            assert_eq!(response.status, 200, "{}", response.text);
            let before = host.ops();
            let id = create(&s, scheduled, on, false).await?;
            let result = run(&s, &id, scheduled).await?;
            attention(&s, &result, code).await?;
            let after = host.ops();
            let added = &after[before.len()..];
            assert_eq!(
                added.iter().filter(|op| *op == "tab.open").count(),
                usize::from(code.is_none())
            );
            assert_eq!(
                added.iter().filter(|op| *op == "tab.observe").count(),
                usize::from(code.is_none())
            );
            assert!(
                added.iter().any(|op| op == "tabs.list"),
                "other steps continue"
            );
        }
    }
    s.finish().await
}
