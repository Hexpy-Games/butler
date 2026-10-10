//! A schedule's first tool inherits grants even before its turn id is recorded.
use super::host::{admin, attach, call, call_turn, snapshot, tab};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, gateway::turn_state, scenario::Setup};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const ASK: &str = "Read the signed-in page";
const SITE: &str = "fixture-shop.test";
const URL: &str = "https://fixture-shop.test/account";

#[tokio::test]
async fn schedule_first_browser_call_inherits_before_turn_id_is_recorded()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-SCHEDULE-EARLY")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = admin(&s);
    let target =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Target"}))
            .await?;
    let target = target.data()["session"]["id"].as_str().unwrap().to_owned();
    call(&admin, "general", "signin.grant", "", json!({"site":SITE})).await?;
    let host = attach(&s, Arc::new(|frame: Value| Box::pin(async move {
        json!({"status":"ok","tab":frame["tab"],"url":URL,"obs":"o1","text":"heading Account [e1]"})
    }))).await?;
    snapshot(
        &admin,
        json!([tab(
            "early-tab",
            &format!("conversation:{target}"),
            URL,
            "agent"
        )]),
    )
    .await?;
    let created =
        s.gw.post(
            "/automations",
            json!({"title":"Read account","prompt_body":ASK,
        "target_session_id":target,"interval_seconds":3600,"source_session_id":"general"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let automation = created.data()["automation"]["id"].as_str().unwrap();
    let held = s.provider()?.hold_next_reply(ASK);
    let run =
        s.gw.post(&format!("/automations/{automation}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn = run.data()["run"]["turn_id"].as_str().unwrap().to_owned();
    // Reproduce the pre-completion window deterministically, before the stub's
    // first tool. Keep the run/input binding and all authority facts intact.
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(
        db.execute(
            "UPDATE app_automation_runs SET turn_id=NULL WHERE id=?1",
            [run.data()["run"]["id"].as_str().unwrap()]
        )?,
        1
    );
    drop(db);
    held.release();
    let done =
        s.gw.wait_terminal(&target, &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    assert!(
        host.ops().contains(&"tab.observe".to_owned()),
        "first tool dispatched without an extra card"
    );
    assert_eq!(s.gw.approval_requests(&target).await?, Vec::<Value>::new());
    let normal = call(&admin, &target, "tab.observe", "early-tab", json!({})).await?;
    assert_eq!(normal["reason"], "signed_in_grant_required");
    let revoked = admin
        .send(
            reqwest::Method::POST,
            "/security/signins/site",
            Some(json!({"site":SITE,"revoke":true})),
            &[],
        )
        .await?;
    assert_eq!(revoked.status, 200, "{}", revoked.text);
    let revoked = call_turn(
        &admin,
        &target,
        "tab.observe",
        "early-tab",
        json!({}),
        Some(&turn),
    )
    .await?;
    assert_eq!(
        revoked["reason"], "signed_in_grant_required",
        "revocation applies to inherited grants"
    );
    s.finish().await
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        ("tool_describe", json!({"ids":["native:browser_observe"]})),
        (
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"early-tab"}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response =
            super::super::browser_usage::stub::response(&json!({"type":"function_call",
            "id":format!("fc_early_{index}"),"call_id":format!("call_early_{index}"),
            "name":name,"arguments":args.to_string(),"status":"completed"}));
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = super::super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_early",
        "role":"assistant","status":"completed","content":[{"type":"output_text","text":"Read.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
