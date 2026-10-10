//! `browser_sign_in` end to end with a stub model: the ask card names the site
//! and account, the fill hands an MFA step to the user, the call waits durably
//! and resumes on the hand-back; the canary never reaches the model, the
//! transcript, events, logs or the data folder. Keychain opt-in (see fill.rs).
use super::fill::{CANARY, keychain_opt_in};
use super::host::{admin, attach, call, snapshot, tab};
use butler_e2e::e2e::{
    HarnessError, cassette::Cassette, gateway::turn_state, scenario::accepted_turn_id,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const LOGIN: &str = "https://login.fixture-shop.test/session";
const ASK: &str = "Sign in to the shop";

#[tokio::test]
async fn sign_in_asks_hands_mfa_to_the_user_and_resumes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "system keychain check needs BUTLER_PLATFORM_SYSTEM_SECRETS=1"
    );
    let s = super::fill::keychain_scenario_with("BROWSER-SIGNIN-TOOL", Some(cassette()?)).await?;
    let admin = admin(&s);
    let added = admin
        .send(Method::POST, "/security/signins", Some(json!({"origin":"https://login.fixture-shop.test","username":"owner@fixture.test","password":CANARY})), &[])
        .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let entry = added.data()["id"].as_str().unwrap().to_owned();
    let mut cleanup = super::fill::Cleanup::new(&admin);
    cleanup.track(&entry);
    let pull_admin = admin.clone();
    let host = attach(
        &s,
        Arc::new(move |frame: Value| {
            let admin = pull_admin.clone();
            Box::pin(async move {
                if frame["op"] != "signin.fill" {
                    return json!({"status":"ok","tab":frame["tab"],"url":LOGIN});
                }
                let token = frame["args"]["fill_token"].as_str().unwrap_or("");
                let pulled = admin
                    .send(
                        Method::POST,
                        &format!("/internal/browser-host/credentials/{token}"),
                        Some(json!({"origin":"https://login.fixture-shop.test"})),
                        &[],
                    )
                    .await
                    .unwrap();
                assert_eq!(pulled.status, 200);
                // Main hands the tab to the user and publishes that before it answers.
                snapshot(
                    &admin,
                    json!([tab("t1", "conversation:general", LOGIN, "user")]),
                )
                .await
                .unwrap();
                json!({"status":"user_required","reason":"mfa","url":LOGIN})
            })
        }),
    )
    .await?;
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", LOGIN, "agent")]),
    )
    .await?;
    call(
        &admin,
        "general",
        "signin.grant",
        "",
        json!({"site":"fixture-shop.test"}),
    )
    .await?;

    let id = accepted_turn_id(&s.gw.say("general", ASK).await?)?;
    let card = waiting_card(&s, &id).await?;
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["tool"], "browser_sign_in", "{card}");
    assert_eq!(
        operation["targets"][0], "fixture-shop.test · owner@fixture.test",
        "{card}"
    );
    assert_eq!(
        operation["allow_conversation"], false,
        "every fill is asked once"
    );
    allow(&s, &card).await?;

    let card = waiting_card(&s, &id).await?;
    assert_eq!(
        card["approval"]["operation"]["tool"], "browser_sign_in_wait",
        "{card}"
    );
    assert_eq!(
        card["approval"]["operation"]["targets"],
        json!(["t1", "mfa"])
    );
    // The wait holds while the user has the tab; their hand-back resumes it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        s.gw.approval_requests("general").await?.len(),
        1,
        "still waiting for the user"
    );
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", LOGIN, "agent")]),
    )
    .await?;
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    assert!(host.ops().contains(&"signin.fill".to_owned()));

    let requests = s.provider()?.requests();
    let last = requests.last().unwrap().to_string();
    assert!(
        last.contains("\\\"status\\\":\\\"ready\\\""),
        "the call resumed after the hand-back: {last}"
    );
    assert!(
        !requests
            .iter()
            .any(|request| request.to_string().contains(CANARY)),
        "canary reached the model"
    );
    let messages = s.gw.messages("general").await?;
    assert!(
        !json!(messages).to_string().contains(CANARY),
        "canary in transcript"
    );
    assert!(!s.gw.get("/events?limit=500").await?.text.contains(CANARY));
    assert_eq!(
        admin
            .send(
                Method::DELETE,
                &format!("/security/signins/{entry}"),
                None,
                &[]
            )
            .await?
            .status,
        200
    );
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    super::canary_absent(&s.sandbox.logs, CANARY, "");
    s.finish().await
}

async fn waiting_card(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
) -> Result<Value, HarnessError> {
    for _ in 0..100 {
        let paused =
            s.gw.wait_turn(
                "general",
                id,
                &["waiting_for_form", "delivered", "failed"],
                Duration::from_secs(20),
            )
            .await?;
        assert_eq!(turn_state(&paused), "waiting_for_form", "{paused}");
        if let Some(card) = s.gw.approval_requests("general").await?.into_iter().next() {
            return Ok(card);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no approval card");
}

async fn allow(s: &butler_e2e::e2e::scenario::Scenario, card: &Value) -> Result<(), HarnessError> {
    let reference = card["request_ref"].as_str().unwrap();
    let response =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(response.status, 202, "{}", response.text);
    // The next card replaces this one; wait until this one is gone.
    for _ in 0..100 {
        if !s
            .gw
            .approval_requests("general")
            .await?
            .iter()
            .any(|item| item["request_ref"] == reference)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        ("tool_describe", json!({"ids":["native:browser_sign_in"]})),
        (
            "tool_call",
            json!({"id":"native:browser_sign_in","arguments":{"tab":"t1"}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response = super::super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_signin_{index}"),"call_id":format!("call_signin_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = super::super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_signin","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Signed in.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
