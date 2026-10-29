//! `browser_pay_fill` end to end with a stub model: the ask card names the
//! merchant origin, the amount, the card by nickname and last four, and the
//! payment window; a paired phone answers it; a 3-D Secure step hands the tab
//! to the user and the call resumes on the hand-back. The canary never reaches
//! the model, the transcript, events, logs or the data folder.
use super::super::fill::keychain_opt_in;
use super::super::tool::waiting_card;
use super::{CANARY, CARD, CHECKOUT, Cleanup, admin, attach, snapshot, tab, vault_scenario};
use crate::gateway_pairing::support::helpers::{browser, connect, cookie_pair, issue};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, gateway::turn_state};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const ASK: &str = "Fill my everyday card in the form";
const TOP: &str = "https://www.fixture-shop.test";
const PAY: &str = "https://js.tosspayments.com";

#[tokio::test]
async fn pay_fill_asks_on_the_phone_hands_3ds_to_the_user_and_resumes() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "system keychain check needs BUTLER_PLATFORM_SYSTEM_SECRETS=1"
    );
    let s = vault_scenario("BROWSER-VAULT-TOOL", Some(cassette()?)).await?;
    let admin = admin(&s);
    let card = json!({"nickname": "Everyday card", "number": CARD, "exp_month": 12, "exp_year": 2030, "cvc": "737"});
    let added = admin
        .send(Method::POST, "/security/vault/cards", Some(card), &[])
        .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let card_id = added.data()["id"].as_str().unwrap().to_owned();
    let mut cleanup = Cleanup::new(&admin);
    cleanup.track("cards", &card_id);
    let pull_admin = admin.clone();
    let host = attach(&s, Arc::new(move |frame: Value| {
        let admin = pull_admin.clone();
        Box::pin(async move {
            match frame["op"].as_str() {
                Some("pay.inspect") => json!({"status":"ok","tab":"t1","url":CHECKOUT,"top_origin":TOP,"merchant_origin":TOP,
                    "frame_origins":[PAY],"fields":["number","expiry","cvc"],"amount":"59,800원","human_step":null}),
                Some("pay.fill") => {
                    let token = frame["args"]["fill_token"].as_str().unwrap_or("");
                    let pulled = admin.send(Method::POST, &format!("/internal/browser-host/vault/{token}"),
                        Some(json!({"origin": TOP, "frame_origins": [PAY]})), &[]).await.unwrap();
                    assert_eq!(pulled.status, 200);
                    // Main hands the tab to the user and publishes that before it answers.
                    snapshot(&admin, json!([tab("t1", "user", CHECKOUT)])).await.unwrap();
                    json!({"status":"user_required","reason":"three_ds","url":CHECKOUT,"frame_origin":PAY,"filled":["number","expiry","cvc"]})
                }
                _ => json!({"status":"ok","tab":frame["tab"],"url":CHECKOUT}),
            }
        })
    })).await?;
    snapshot(&admin, json!([tab("t1", "agent", CHECKOUT)])).await?;
    let id = s.gw.say_turn("general", ASK).await?;
    let card = waiting_card(&s, &id).await?;
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["tool"], "browser_pay_fill", "{card}");
    assert_eq!(
        operation["targets"],
        json!([
            format!("{TOP} · 59,800원"),
            "Everyday card · •••• 5556",
            PAY
        ]),
        "{card}"
    );
    assert_eq!(
        operation["allow_conversation"], false,
        "every fill is asked once"
    );
    assert!(!card.to_string().contains(CANARY));
    phone_allows(&s, &admin, &card).await?;

    let wait = waiting_card(&s, &id).await?;
    assert_eq!(
        wait["approval"]["operation"]["tool"], "browser_pay_wait",
        "{wait}"
    );
    assert_eq!(wait["approval"]["operation"]["wait_reason"], "three_ds");
    assert_eq!(
        wait["approval"]["operation"]["targets"],
        json!(["fixture-shop.test"])
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    snapshot(&admin, json!([tab("t1", "agent", CHECKOUT)])).await?;
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    assert!(host.ops().contains(&"pay.fill".to_owned()));
    let requests = s.provider()?.requests();
    assert!(
        requests
            .last()
            .unwrap()
            .to_string()
            .contains("\\\"status\\\":\\\"ready\\\""),
        "resumed after the hand-back"
    );
    assert!(
        !requests
            .iter()
            .any(|request| request.to_string().contains(CANARY)),
        "canary reached the model"
    );
    assert!(
        !json!(s.gw.messages("general").await?)
            .to_string()
            .contains(CANARY),
        "canary in transcript"
    );
    assert!(!s.gw.get("/events?limit=500").await?.text.contains(CANARY));
    let deleted = admin
        .send(
            Method::DELETE,
            &format!("/security/vault/cards/{card_id}"),
            None,
            &[],
        )
        .await?;
    assert_eq!(
        deleted.status, 200,
        "the keychain item is deleted: {}",
        deleted.text
    );
    drop(cleanup);
    super::super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    super::super::canary_absent(&s.sandbox.logs, CANARY, "");
    s.finish().await
}

/// A paired phone answers the card; it cannot open the vault itself.
async fn phone_allows(
    s: &butler_e2e::e2e::scenario::Scenario,
    admin: &butler_e2e::e2e::security::AdminClient,
    card: &Value,
) -> Result<(), HarnessError> {
    let phone = browser();
    let code = issue(admin).await?;
    let cookie = cookie_pair(&connect(&s.gw, &phone, code["code"].as_str().unwrap()).await?);
    let send = |method: Method, path: String, body: Option<Value>| {
        let mut request = phone
            .request(method, format!("{}{path}", s.gw.base))
            .header("cookie", &cookie)
            .header("origin", &s.gw.base)
            .header("sec-fetch-site", "same-origin");
        if let Some(body) = body {
            request = request.json(&body);
        }
        request.send()
    };
    let vault = send(Method::GET, "/security/vault".into(), None).await?;
    assert_eq!(vault.status().as_u16(), 403, "the vault is the host's only");
    let listed: Value = send(
        Method::GET,
        "/authority-requests?session_id=general".into(),
        None,
    )
    .await?
    .json()
    .await?;
    assert!(
        listed.to_string().contains("59,800원"),
        "the phone sees the amount: {listed}"
    );
    let reference = card["request_ref"].as_str().unwrap();
    let answered = send(
        Method::POST,
        format!("/authority-requests/{reference}/allow?session_id=general"),
        Some(json!({"scope":"once"})),
    )
    .await?;
    assert_eq!(answered.status().as_u16(), 202);
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
        ("tool_describe", json!({"ids":["native:browser_pay_fill"]})),
        (
            "tool_call",
            json!({"id":"native:browser_pay_fill","arguments":{"tab":"t1","card_ref":"Everyday card"}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response = crate::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_pay_{index}"),"call_id":format!("call_pay_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = crate::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_pay","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Card filled; the issuer check is done.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
