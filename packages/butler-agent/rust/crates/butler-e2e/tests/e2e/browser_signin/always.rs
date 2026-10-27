//! A real card writes the existing standing allow; other chats and schedules
//! inherit it, while revocation fences live identity tabs and restores the card.
mod delegation;
mod payment;
mod schedule_cards;
mod schedule_migration;
mod schedules;
mod support;
mod upgrade;
use super::host::{admin, attach, call, snapshot, tab};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Access, Setup},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use support::{ASK, begin, cassette, decide, delivered, session};

const URL: &str = "https://account.fixture-shop.test/account";
const SITE: &str = "fixture-shop.test";

fn observe() -> Result<butler_e2e::e2e::cassette::Cassette, HarnessError> {
    cassette(vec![
        ("tool_describe", json!({"ids":["native:browser_observe"]})),
        (
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"identity"}}),
        ),
    ])
}

#[tokio::test]
async fn signed_in_site_card_covers_chats_and_schedules_then_revokes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::AskExceptReads, Access::Auto] {
        standing_flow(access).await?;
    }
    Ok(())
}

async fn standing_flow(access: Access) -> Result<(), HarnessError> {
    let s = Setup::new("BROWSER-ALWAYS-SIGNIN")?
        .access(access)
        .stub_cassette(observe()?)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame: Value| {
            Box::pin(async move {
                json!({"status":"ok","tab":frame["tab"],"url":URL,"obs":"o1","text":"Account"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin,
        json!([tab("identity", "conversation:general", URL, "agent")]),
    )
    .await?;
    let id = begin(&s, "general").await?;
    let card = super::tool::waiting_card(&s, &id).await?;
    assert_eq!(card["approval"]["operation"]["allow_site"], "signed_in");
    assert_eq!(card["approval"]["operation"]["targets"], json!([SITE]));
    decide(&s, "general", &card, "site").await?;
    delivered(&s, "general", &id).await?;
    let listed = admin
        .send(Method::GET, "/security/signins", None, &[])
        .await?;
    let row = &listed.data()["sites"][0];
    assert_eq!(row["all_conversations"], true);
    let mut signed_out = tab("plain", "conversation:general", URL, "agent");
    signed_out["profile"] = json!("signed_out");
    snapshot(
        &admin,
        json!([
            tab("identity", "conversation:general", URL, "agent"),
            signed_out
        ]),
    )
    .await?;
    call(&admin, "general", "tab.observe", "plain", json!({})).await?;
    assert_ne!(
        host.last("tab.observe").unwrap()["args"]["policy"]["mode"],
        "signed_in"
    );
    let other = session(&s).await?;
    snapshot(
        &admin,
        json!([tab(
            "identity",
            &format!("conversation:{other}"),
            URL,
            "agent"
        )]),
    )
    .await?;
    let id = begin(&s, &other).await?;
    delivered(&s, &other, &id).await?;
    // A third conversation's schedule has no conversation grants to inherit.
    let scheduled = session(&s).await?;
    snapshot(
        &admin,
        json!([tab(
            "identity",
            &format!("conversation:{scheduled}"),
            URL,
            "agent"
        )]),
    )
    .await?;
    let created =
        s.gw.post(
            "/automations",
            json!({"title":"Read account","prompt_body":ASK,
        "target_session_id":scheduled,"interval_seconds":3600,"browser_signin":true,"source_session_id":other}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let schedule = created.data()["automation"]["id"].as_str().unwrap();
    let run =
        s.gw.post(&format!("/automations/{schedule}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn = run.data()["run"]["turn_id"].as_str().unwrap();
    delivered(&s, &scheduled, turn).await?;
    let off = admin
        .send(
            Method::POST,
            "/security/signins/site",
            Some(json!({"site":SITE,"all_conversations":false})),
            &[],
        )
        .await?;
    assert_eq!(off.status, 200, "{}", off.text);
    for _ in 0..100 {
        if host.last("use.signin_revoked").is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        host.last("use.signin_revoked").unwrap()["args"]["site"],
        SITE
    );
    let refused = call(&admin, &scheduled, "tab.observe", "identity", json!({})).await?;
    assert_eq!(refused["reason"], "signed_in_grant_required");
    snapshot(
        &admin,
        json!([tab("identity", "conversation:general", URL, "agent")]),
    )
    .await?;
    let id = begin(&s, "general").await?;
    let card = super::tool::waiting_card(&s, &id).await?;
    decide(&s, "general", &card, "once").await?;
    delivered(&s, "general", &id).await?;
    s.finish().await
}

#[tokio::test]
async fn signed_in_once_does_not_grant_another_conversation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-SIGNIN-ONCE")?
        .stub_cassette(observe()?)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(
        &s,
        Arc::new(|frame: Value| {
            Box::pin(async move {
                json!({"status":"ok","tab":frame["tab"],"url":URL,"obs":"o1","text":"Account"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin,
        json!([tab("identity", "conversation:general", URL, "agent")]),
    )
    .await?;
    let id = begin(&s, "general").await?;
    let card = super::tool::waiting_card(&s, &id).await?;
    decide(&s, "general", &card, "once").await?;
    delivered(&s, "general", &id).await?;
    let id = begin(&s, "general").await?;
    delivered(&s, "general", &id).await?;
    let other = session(&s).await?;
    snapshot(
        &admin,
        json!([tab(
            "identity",
            &format!("conversation:{other}"),
            URL,
            "agent"
        )]),
    )
    .await?;
    let id = begin(&s, &other).await?;
    let paused =
        s.gw.wait_turn(&other, &id, &["waiting_for_form"], Duration::from_secs(20))
            .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&paused),
        "waiting_for_form"
    );
    let cards = s.gw.approval_requests(&other).await?;
    assert_eq!(cards.len(), 1);
    decide(&s, &other, &cards[0], "once").await?;
    delivered(&s, &other, &id).await?;
    // A normal agent tab still gets the signed-out policy despite a grant.
    let mut agent = tab("agent", &format!("conversation:{other}"), URL, "agent");
    agent["profile"] = json!("signed_out");
    snapshot(&admin, json!([agent])).await?;
    call(&admin, &other, "tab.observe", "agent", json!({})).await?;
    assert_ne!(
        host.last("tab.observe").unwrap()["args"]["policy"]["mode"],
        "signed_in"
    );
    s.finish().await
}
