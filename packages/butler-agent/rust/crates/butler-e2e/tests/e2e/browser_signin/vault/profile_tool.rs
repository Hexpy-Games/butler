//! The general profile tool asks for the exact site and profile, and never returns values.
use super::super::tool::waiting_card;
use super::{Cleanup, admin, attach, snapshot, tab, vault_scenario};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, gateway::turn_state};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORIGIN: &str = "https://forms.example.test";
const ASK: &str = "Fill the form from my Self profile";

#[tokio::test]
async fn autofill_tool_asks_by_profile_id_and_keeps_values_out_of_the_model()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        super::super::fill::keychain_opt_in(),
        "system keychain opt-in required"
    );
    let mut s = vault_scenario("AUTOFILL-TOOL", Some(cassette()?)).await?;
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO browser_autofill_profiles(id,nickname,details_json,created_at) VALUES(?1,'Self',?2,'2026-10-01')",
        rusqlite::params![ID, json!({"name":"Sample Person","email":"self@example.test","country":"KR"}).to_string()])?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let admin = admin(&s);
    let mut cleanup = Cleanup::new(&admin);
    cleanup.track("profiles", ID);
    let host = attach(&s, Arc::new(|frame: Value| Box::pin(async move {
        match frame["op"].as_str() {
            Some("pay.inspect") => json!({"status":"ok","top_origin":ORIGIN,"merchant_origin":ORIGIN,
                "frame_origins":[ORIGIN],"fields":["full_name","email","country"]}),
            Some("autofill.fill") => {
                assert_eq!(frame["args"]["item_id"], ID);
                assert_eq!(frame["args"]["targets"], targets());
                assert!(frame["args"]["fill_token"].as_str().is_some());
                json!({"status":"filled","url":ORIGIN,"filled":["full_name","email","country"],"missing":[]})
            }
            _ => json!({"status":"ok","tab":frame["tab"],"url":ORIGIN}),
        }
    }))).await?;
    snapshot(&admin, json!([tab("t1", "agent", ORIGIN)])).await?;
    let turn = s.gw.say_turn("general", ASK).await?;
    let card = waiting_card(&s, &turn).await?;
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["tool"], "browser_autofill_fill");
    assert_eq!(operation["allow_conversation"], false);
    assert_eq!(
        operation["targets"],
        json!([ORIGIN, "Self", "full_name, email, country"])
    );
    let answered = admin
        .send(
            Method::POST,
            &format!(
                "/authority-requests/{}/allow?session_id=general",
                card["request_ref"].as_str().unwrap()
            ),
            Some(json!({"scope":"once"})),
            &[],
        )
        .await?;
    assert_eq!(answered.status, 202);
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered");
    assert!(host.ops().contains(&"autofill.fill".to_owned()));
    let requests = s
        .provider()?
        .requests()
        .iter()
        .map(Value::to_string)
        .collect::<String>();
    assert!(!requests.contains("Sample Person") && !requests.contains("self@example.test"));
    drop(cleanup);
    s.finish().await
}

fn targets() -> Value {
    json!([{"ref":"f0-e1","field":"full_name"},{"ref":"f0-e2","field":"email"},{"ref":"f0-e3","field":"country"}])
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        (
            "tool_describe",
            json!({"ids":["native:browser_autofill_fill"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_autofill_fill","arguments":{"tab":"t1","profile_id":ID,"targets":targets()}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response = crate::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_profile_{index}"),
            "call_id":format!("call_profile_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = crate::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_profile","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":"Profile fields filled.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
