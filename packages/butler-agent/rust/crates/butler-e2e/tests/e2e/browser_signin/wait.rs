//! `browser_wait_for_user` with a stub model: the user holds the tab for a
//! secure field; the hand-off card names the site and why (never the tab id),
//! another tab's changes never resume it, and the hand-back does.
use super::host::{admin, attach, snapshot, tab};
use super::tool::waiting_card;
use butler_e2e::e2e::{
    HarnessError, cassette::Cassette, gateway::turn_state, scenario::Setup,
    scenario::accepted_turn_id,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const CHECKOUT: &str = "https://www.fixture-shop.test/checkout";
const ASK: &str = "Help me enter the card number";

#[tokio::test]
async fn wait_for_user_card_names_the_site_and_resumes_on_hand_back() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-WAIT-HANDOFF")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame: Value| {
            Box::pin(async move {
                // Main parks the tab the user holds.
                if frame["op"] == "tab.wait" {
                    return json!({"status":"user_control","tab":frame["tab"],"epoch":1});
                }
                json!({"status":"ok","tab":frame["tab"],"url":CHECKOUT})
            })
        }),
    )
    .await?;
    // The user took the tab over; Butler holds another tab in the conversation.
    let tabs = |holder: &str| {
        json!([
            tab("t1", "conversation:general", CHECKOUT, holder),
            tab("t2", "conversation:general", CHECKOUT, "agent")
        ])
    };
    snapshot(&admin, tabs("user")).await?;

    let id = accepted_turn_id(&s.gw.say("general", ASK).await?)?;
    let card = waiting_card(&s, &id).await?;
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["tool"], "browser_wait_for_user", "{card}");
    assert_eq!(operation["targets"], json!(["fixture-shop.test"]), "{card}");
    assert_eq!(operation["wait_reason"], "secure_field", "{card}");
    assert_eq!(operation["allow_conversation"], false);
    assert!(
        !operation.to_string().contains("\"t1\""),
        "no tab id on the card: {card}"
    );
    assert!(host.ops().contains(&"tab.wait".to_owned()));

    // Only this tab's hand-back resumes the wait.
    snapshot(&admin, tabs("user")).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        s.gw.approval_requests("general").await?.len(),
        1,
        "still waiting for the user"
    );
    snapshot(&admin, tabs("agent")).await?;
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    let requests = s.provider()?.requests();
    let last = requests.last().unwrap().to_string();
    assert!(
        last.contains("\\\"status\\\":\\\"ready\\\""),
        "the call resumed after the hand-back: {last}"
    );
    s.finish().await
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        (
            "tool_describe",
            json!({"ids":["native:browser_wait_for_user"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_wait_for_user","arguments":{"tab":"t1","reason":"secure_field"}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response = super::super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_wait_{index}"),"call_id":format!("call_wait_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = super::super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_wait","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
