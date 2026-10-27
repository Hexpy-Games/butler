//! A payment card grants the merchant, covering future saved-card fills and
//! final-click policy. Revocation returns the fill card without closing tabs.
mod schedules;
use super::super::{
    host::{admin, attach, snapshot},
    vault::{CARD, CHECKOUT, Cleanup, tab, vault_scenario},
};
use super::support::{begin, cassette, decide, delivered};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const TOP: &str = "https://www.fixture-shop.test";
const SITE: &str = "fixture-shop.test";

fn script() -> Result<butler_e2e::e2e::cassette::Cassette, HarnessError> {
    cassette(vec![
        (
            "tool_describe",
            json!({"ids":["native:browser_pay_fill","native:browser_act"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_pay_fill","arguments":{"tab":"t1"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_act","arguments":{"tab":"t1","observation":"o1","steps":[{"action":"click","ref":"e1","commits":true}]}}),
        ),
    ])
}

#[tokio::test]
async fn payment_site_card_covers_fill_and_click_with_audit_and_event() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for access in ["auto", "ask_first"] {
        payment_flow(access).await?;
    }
    Ok(())
}

async fn payment_flow(access: &str) -> Result<(), HarnessError> {
    let s = vault_scenario("BROWSER-ALWAYS-PAYMENT", Some(script()?)).await?;
    let admin = admin(&s);
    let signin = admin
        .send(
            Method::POST,
            "/security/signins/site",
            Some(json!({"site":SITE,"all_conversations":true})),
            &[],
        )
        .await?;
    assert_eq!(signin.status, 200, "{}", signin.text);
    let changed =
        s.gw.patch("/settings", json!({"access_mode":access}))
            .await?;
    assert_eq!(changed.status, 200, "{}", changed.text);
    let added = admin
        .send(
            Method::POST,
            "/security/vault/cards",
            Some(json!({"nickname":"Everyday",
        "number":CARD,"exp_month":12,"exp_year":2030})),
            &[],
        )
        .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let card_id = added.data()["id"].as_str().unwrap().to_owned();
    let mut cleanup = Cleanup::new(&admin);
    cleanup.track("cards", &card_id);
    let host = attach(&s, Arc::new(|frame: Value| Box::pin(async move {
        match frame["op"].as_str() {
            Some("pay.inspect") => json!({"status":"ok","url":CHECKOUT,"top_origin":TOP,
                "merchant_origin":TOP,"frame_origins":[TOP],"fields":["number"],"amount":"59,800원"}),
            Some("pay.fill") => json!({"status":"filled","url":CHECKOUT,"filled":["number"],"missing":[]}),
            Some("tab.prepare") => json!({"status":"ok","tab":"t1","url":CHECKOUT,"profile":"signed_out","obs":"o1",
                "steps":[{"action":"click","payment":true,"submit":true,"form_post":true,"hit":{"role":"button","name":"Pay 59,800원","frame":""}}]}),
            Some("tab.act") => json!({"status":"ok","url":CHECKOUT,"steps":[{"status":"ok"}]}),
            _ => json!({"status":"ok","tab":frame["tab"],"url":CHECKOUT,"obs":"o1","text":"Checkout"}),
        }
    }))).await?;
    snapshot(
        &admin,
        json!([
            tab("t1", "agent", CHECKOUT),
            super::super::host::tab("account", "conversation:general", CHECKOUT, "agent")
        ]),
    )
    .await?;
    let id = begin(&s, "general").await?;
    let card = super::super::tool::waiting_card(&s, &id).await?;
    assert_eq!(card["approval"]["operation"]["allow_site"], "payment");
    assert_eq!(
        card["approval"]["operation"]["targets"][0],
        format!("{TOP} · 59,800원")
    );
    decide(&s, "general", &card, "site").await?;
    let purchase = next_card(&s, &id, &card).await?;
    assert_eq!(purchase["approval"]["operation"]["tool"], "browser_act");
    decide(&s, "general", &purchase, "once").await?;
    delivered(&s, "general", &id).await?;
    let id = begin(&s, "general").await?;
    let purchase = super::super::tool::waiting_card(&s, &id).await?;
    assert_eq!(purchase["approval"]["operation"]["tool"], "browser_act");
    decide(&s, "general", &purchase, "once").await?;
    delivered(&s, "general", &id).await?;
    assert_eq!(host.ops().iter().filter(|op| *op == "pay.fill").count(), 2);
    assert_eq!(host.ops().iter().filter(|op| *op == "tab.act").count(), 2);
    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(view.data()["purchase_sites"], json!([SITE]));
    assert_eq!(view.data()["cards"][0]["uses"].as_array().unwrap().len(), 2);
    assert_eq!(view.data()["cards"][0]["uses"][0]["result"], "filled");
    let events = s.gw.get("/events?limit=500").await?;
    assert_eq!(events.status, 200);
    let skipped: Vec<_> = events.data()["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "browser.payment_confirmation_skipped")
        .collect();
    assert_eq!(skipped.len(), 3, "one first click, then a fill and a click");
    for event in skipped {
        assert_eq!(event["payload"]["site"], SITE);
        assert_eq!(event["payload"]["amount"], "59,800원");
        assert_eq!(event["payload"]["session_id"], "general");
    }
    let off = admin
        .send(
            Method::POST,
            "/security/vault/purchase-sites",
            Some(json!({"site":SITE,"allow":false})),
            &[],
        )
        .await?;
    assert_eq!(off.status, 200, "{}", off.text);
    assert!(host.last("use.signin_revoked").is_none());
    let account =
        super::super::host::call(&admin, "general", "tab.observe", "account", json!({})).await?;
    assert_eq!(
        account["status"], "ok",
        "payment revocation preserves signed-in access"
    );
    let lookup = super::super::host::call(&admin, "general", "pay.lookup", "t1", json!({})).await?;
    assert_eq!(lookup["status"], "ok", "the tab stays usable");
    assert_eq!(lookup["purchase_allowed"], false);
    let id = begin(&s, "general").await?;
    let fill = super::super::tool::waiting_card(&s, &id).await?;
    decide(&s, "general", &fill, "once").await?;
    // Wait for the first card to be replaced before examining the purchase card.
    let purchase = next_card(&s, &id, &fill).await?;
    assert_eq!(purchase["approval"]["operation"]["tool"], "browser_act");
    assert_eq!(purchase["approval"]["operation"]["allow_site"], "payment");
    decide(&s, "general", &purchase, "site").await?;
    delivered(&s, "general", &id).await?;
    let id = begin(&s, "general").await?;
    let purchase = super::super::tool::waiting_card(&s, &id).await?;
    assert_eq!(purchase["approval"]["operation"]["tool"], "browser_act");
    decide(&s, "general", &purchase, "once").await?;
    delivered(&s, "general", &id).await?;
    // A different merchant is never covered by this site's standing allow.
    snapshot(
        &admin,
        json!([tab("t1", "agent", "https://another-shop.test/checkout")]),
    )
    .await?;
    let lookup = super::super::host::call(&admin, "general", "pay.lookup", "t1", json!({})).await?;
    assert_eq!(lookup["purchase_allowed"], false);
    drop(cleanup);
    s.finish().await
}

async fn next_card(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
    previous: &Value,
) -> Result<Value, HarnessError> {
    for _ in 0..100 {
        let card = super::super::tool::waiting_card(s, id).await?;
        if card["request_ref"] != previous["request_ref"] {
            return Ok(card);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("payment card did not replace fill card");
}

#[tokio::test]
async fn popup_purchase_card_displays_and_saves_the_checked_merchant() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let script = cassette(vec![
        ("tool_describe", json!({"ids":["native:browser_act"]})),
        (
            "tool_call",
            json!({"id":"native:browser_act","arguments":{"tab":"checkout","observation":"o1","steps":[{"action":"click","ref":"e1","commits":true}]}}),
        ),
    ])?;
    let s = vault_scenario("BROWSER-PAYMENT-POPUP-MERCHANT", Some(script)).await?;
    let admin = admin(&s);
    let host = attach(&s, Arc::new(|frame: Value| Box::pin(async move {
        if frame["op"] == "tab.prepare" {
            json!({"status":"ok","tab":"checkout","url":"https://checkout.stripe.com/pay","profile":"signed_out","obs":"o1",
                "steps":[{"action":"click","payment":true,"submit":true,"form_post":true,"hit":{"role":"button","name":"Pay","frame":""}}]})
        } else { json!({"status":"ok","url":"https://checkout.stripe.com/pay","steps":[{"status":"ok"}]}) }
    }))).await?;
    let mut checkout = tab("checkout", "agent", "https://checkout.stripe.com/pay");
    checkout["opener"] = json!("merchant");
    snapshot(
        &admin,
        json!([
            tab("merchant", "agent", "https://shop-a.test/cart"),
            checkout
        ]),
    )
    .await?;
    let turn = begin(&s, "general").await?;
    let card = super::super::tool::waiting_card(&s, &turn).await?;
    let displayed = card["approval"]["operation"]["targets"][0]
        .as_str()
        .unwrap();
    assert_eq!(displayed, "shop-a.test");
    assert_eq!(card["approval"]["operation"]["allow_site"], "payment");
    decide(&s, "general", &card, "site").await?;
    delivered(&s, "general", &turn).await?;
    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(view.data()["purchase_sites"], json!([displayed]));
    assert_eq!(host.ops().iter().filter(|op| *op == "tab.act").count(), 1);
    s.finish().await
}
