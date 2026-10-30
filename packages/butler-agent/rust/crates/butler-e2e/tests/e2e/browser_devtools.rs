//! `browser_devtools`: read-only console, network and DOM reads through the
//! real tool path, gateway and approval store, with a scripted browser host.
//! Pages Butler made and local dev servers never ask; a site without a sign-in
//! asks once per site and offers the conversation-wide allow; a signed-in tab
//! asks every time and is read masked; the grant follows the page the tab is
//! on when the read runs, not the page it was on when someone said yes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod host;
mod masking;

use super::browser_approval::host::{call, cassette};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Scenario, Setup},
};
use host::{Host, SECRETS};
use serde_json::{Value, json};
use std::time::Duration;

const SHOP: &str = "https://shop.example.test/cart";
const BLOG: &str = "https://blog.example.test/post?id=1";
const OTHER: &str = "https://www.other.test/";
const ACCOUNT: &str = "https://app.bank.test/home";

fn read(tab: &str, what: &str) -> Value {
    call("browser_devtools", json!({"tab":tab,"read":what}))
}

fn turn(text: &str, calls: Vec<Value>) -> (String, Vec<Value>) {
    (text.into(), calls)
}

async fn ask(s: &Scenario, text: &str) -> Result<(String, Option<Value>), HarnessError> {
    let id = s.gw.say_turn("general", text).await?;
    let states = ["waiting_for_form", "delivered", "failed"];
    for _ in 0..100 {
        let current =
            s.gw.wait_turn("general", &id, &states, Duration::from_secs(30))
                .await?;
        match turn_state(&current) {
            "delivered" => return Ok((id, None)),
            "failed" => panic!("{current}\n{}", s.agent.logs()),
            _ => {}
        }
        if let Some(card) = s.gw.approval_requests("general").await?.into_iter().next() {
            return Ok((id, Some(card)));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("turn neither delivered nor asked");
}

async fn allow(s: &Scenario, id: &str, card: &Value, scope: &str) -> Result<(), HarnessError> {
    let reference = card["request_ref"].as_str().unwrap();
    let response =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({ "scope": scope }),
        )
        .await?;
    assert_eq!(response.status, 202, "{}", response.text);
    let done =
        s.gw.wait_terminal("general", id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    Ok(())
}

fn strings(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(text) => found.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings(item, found)),
        Value::Object(map) => map.values().for_each(|item| strings(item, found)),
        _ => {}
    }
}

/// Everything the model has been sent, as one text.
fn model_text(s: &Scenario) -> String {
    let requests = s.provider().unwrap().requests();
    let mut found = Vec::new();
    for request in &requests {
        strings(request, &mut found);
    }
    found.join("\n")
}

/// The tool results the newest model request carries, parsed.
fn results(s: &Scenario) -> Vec<Value> {
    let requests = s.provider().unwrap().requests();
    let mut found = Vec::new();
    strings(requests.last().unwrap(), &mut found);
    found
        .iter()
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .filter(Value::is_object)
        .map(|value| {
            let output = &value["output"];
            if output.is_object() {
                output.clone()
            } else {
                value
            }
        })
        .collect()
}

fn newest_read(s: &Scenario) -> Value {
    results(s)
        .into_iter()
        .rfind(|value| value["schema"] == "butler.browser-devtools.v1")
        .expect("a DevTools read reached the model")
}

fn assert_no_secrets(text: &str) {
    let leaked: Vec<&&str> = SECRETS
        .iter()
        .filter(|secret| text.contains(**secret))
        .collect();
    assert!(leaked.is_empty(), "leaked: {leaked:?}");
}

#[tokio::test]
async fn butler_pages_and_local_dev_servers_never_ask() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let reads = vec![
        read("made", "console"),
        read("preview", "network"),
        read("dev", "dom"),
        read("dev_signed_in", "network"),
    ];
    let s = Setup::new("BROWSER-DEVTOOLS-LOCAL")?
        .access(Access::AskAlways)
        .stub_cassette(cassette(&[turn("Read the local pages", reads)])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[
            (
                "made",
                "signed_out",
                "http://127.0.0.1:9/__o/report/index.html",
            ),
            ("preview", "signed_out", "http://127.0.0.1:9/__p/p-1/"),
            ("dev", "signed_out", "http://localhost:5173/"),
            ("dev_signed_in", "signed_in", "http://127.0.0.1:3000/"),
        ],
        None,
    )
    .await?;
    let (_, card) = ask(&s, "Read the local pages").await?;
    assert!(card.is_none(), "a local page asked: {card:?}");
    let reads = host.reads();
    assert_eq!(reads.len(), 4, "every read dispatched");
    assert!(reads.iter().all(|args| args["expect"]["place"] == "local"));
    let newest = newest_read(&s);
    assert_eq!(newest["place"], "local", "{newest}");
    assert_eq!(newest["untrusted_content"]["kind"], "web_page_data");
    // No card, but a signed-in profile stays masked even on a local page.
    assert_eq!(newest["read"], "network");
    assert!(newest["untrusted_content"]["entries"][0]["response_headers"].is_null());
    let text = model_text(&s);
    for secret in [
        "SECRET-PASSWORD",
        "SECRET-CSRF",
        "SECRET-SET-COOKIE",
        "SECRET-AUTH",
    ] {
        assert!(!text.contains(secret), "{secret} leaked:\n{text}");
    }
    s.finish().await
}

#[tokio::test]
async fn a_site_without_a_sign_in_asks_once_per_site() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-SITE")?
        .access(Access::AskExceptReads)
        .stub_cassette(cassette(&[
            turn("First read", vec![read("shop", "console")]),
            turn("Second read", vec![read("shop", "console")]),
            turn(
                "Same site",
                vec![read("blog", "network"), read("shop", "dom")],
            ),
            turn("Other site", vec![read("other", "console")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[
            ("shop", "signed_out", SHOP),
            ("blog", "signed_out", BLOG),
            ("other", "signed_out", OTHER),
        ],
        None,
    )
    .await?;

    let (id, card) = ask(&s, "First read").await?;
    let card = card.expect("a new site asks");
    let approval = &card["approval"];
    let operation = &approval["operation"];
    assert_eq!(operation["tool"], "browser_devtools", "{card}");
    assert_eq!(operation["access"], "read_only", "{card}");
    assert_eq!(operation["devtools_read"], "console", "{card}");
    assert_eq!(operation["browser_mode"], "signed_out", "{card}");
    assert_eq!(
        operation["targets"],
        json!(["example.test", "shop.example.test"])
    );
    assert_eq!(operation["allow_conversation"], true, "{card}");
    assert!(operation["allow_site"].is_null(), "{card}");
    assert!(operation["browser_tab"].is_null(), "{card}");
    assert_eq!(approval["risk"], "low", "{card}");
    assert_eq!(approval["action_kind"], "web_request", "{card}");
    assert!(host.reads().is_empty(), "nothing is read before the answer");
    allow(&s, &id, &card, "once").await?;
    assert_eq!(host.reads().len(), 1);

    // Allowing once is that once.
    let (id, card) = ask(&s, "Second read").await?;
    let card = card.expect("allow once does not stand");
    allow(&s, &id, &card, "conversation").await?;
    assert_eq!(host.reads().len(), 2);

    // The grant covers the site: another subdomain, path and read, no card.
    let (_, card) = ask(&s, "Same site").await?;
    assert!(card.is_none(), "the site was allowed: {card:?}");
    assert_eq!(host.reads().len(), 4);

    let (id, card) = ask(&s, "Other site").await?;
    let card = card.expect("another site asks");
    assert_eq!(
        card["approval"]["operation"]["targets"],
        json!(["other.test", "www.other.test"])
    );
    allow(&s, &id, &card, "once").await?;
    assert_eq!(host.reads().len(), 5);
    s.finish().await
}

#[tokio::test]
async fn a_signed_in_tab_asks_every_time_and_reads_masked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-SIGNED-IN")?
        .access(Access::AskExceptReads)
        .stub_cassette(cassette(&[
            turn("Read network", vec![read("acct", "network")]),
            turn("Read document", vec![read("acct", "dom")]),
            turn("Read console", vec![read("acct", "console")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(&s, &[("acct", "signed_in", ACCOUNT)], Some("bank.test")).await?;

    let (id, card) = ask(&s, "Read network").await?;
    let card = card.expect("a signed-in tab asks");
    let approval = &card["approval"];
    let operation = &approval["operation"];
    assert_eq!(operation["browser_mode"], "signed_in", "{card}");
    assert_eq!(operation["devtools_read"], "network", "{card}");
    assert_eq!(operation["allow_conversation"], false, "{card}");
    assert!(operation["allow_site"].is_null(), "{card}");
    assert_eq!(approval["risk"], "medium", "{card}");
    // The server refuses a standing grant even if a client asks for one.
    let reference = card["request_ref"].as_str().unwrap();
    for scope in ["conversation", "site"] {
        let refused =
            s.gw.post(
                &format!("/authority-requests/{reference}/allow?session_id=general"),
                json!({ "scope": scope }),
            )
            .await?;
        assert_ne!(refused.status, 202, "{scope}: {}", refused.text);
    }
    allow(&s, &id, &card, "once").await?;
    let newest = newest_read(&s);
    let row = &newest["untrusted_content"]["entries"][0];
    assert_eq!(row["status"], 500, "{newest}");
    assert_eq!(row["method"], "POST", "{newest}");
    assert_eq!(
        row["url"], "https://api.example.test/v1/save?q=[masked]&access_token=[masked]",
        "{newest}"
    );
    assert!(row["response_headers"].is_null(), "{newest}");
    assert!(
        newest["masked"].to_string().contains("bodies"),
        "the model is told what was masked: {newest}"
    );
    let text = model_text(&s);
    assert_no_secrets(&text);
    assert!(!text.contains("plain-query"), "a signed-in query is masked");

    let (id, card) = ask(&s, "Read document").await?;
    let card = card.expect("asks every time");
    assert_eq!(card["approval"]["operation"]["devtools_read"], "dom");
    allow(&s, &id, &card, "once").await?;
    let document = newest_read(&s);
    let html = document["untrusted_content"]["html"].as_str().unwrap();
    assert!(html.contains("<input type=\"password\""), "{html}");
    assert!(html.contains("value=\"[masked]\""), "{html}");
    assert!(!html.contains("onclick"), "{html}");
    assert!(html.contains("Sign in"), "{html}");
    assert_no_secrets(&model_text(&s));

    let (id, card) = ask(&s, "Read console").await?;
    let card = card.expect("asks every time");
    assert_eq!(card["approval"]["operation"]["devtools_read"], "console");
    allow(&s, &id, &card, "once").await?;
    let console = newest_read(&s);
    let line = console["untrusted_content"]["entries"][0]["text"]
        .as_str()
        .unwrap();
    assert!(line.starts_with("Failed: token=[masked]"), "{line}");
    assert_no_secrets(&model_text(&s));
    assert_eq!(host.reads().len(), 3);
    s.finish().await
}

#[tokio::test]
async fn the_grant_follows_the_page_at_read_time() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-NAVIGATION")?
        .access(Access::AskExceptReads)
        .stub_cassette(cassette(&[
            turn("Allow the shop", vec![read("shop", "console")]),
            turn("After navigating", vec![read("shop", "console")]),
            turn("Back on the shop", vec![read("shop", "console")]),
            turn("Moves during the read", vec![read("shop", "network")]),
            turn("Signed in during the read", vec![read("second", "network")]),
            turn("Now signed in", vec![read("second", "network")]),
            turn("Moves while asking", vec![read("third", "dom")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[
            ("shop", "signed_out", SHOP),
            ("second", "signed_out", SHOP),
            ("third", "signed_out", OTHER),
        ],
        None,
    )
    .await?;
    let (id, card) = ask(&s, "Allow the shop").await?;
    allow(&s, &id, &card.expect("asks"), "conversation").await?;

    // The tab went somewhere else: that site has no grant.
    host.navigate("shop", OTHER).await?;
    let (id, card) = ask(&s, "After navigating").await?;
    let card = card.expect("another site asks again");
    assert_eq!(card["approval"]["operation"]["targets"][0], "other.test");
    allow(&s, &id, &card, "once").await?;
    assert_eq!(host.reads()[1]["expect"]["site"], "other.test");

    // Back on the allowed site, no card.
    host.navigate("shop", SHOP).await?;
    let (_, card) = ask(&s, "Back on the shop").await?;
    assert!(card.is_none(), "{card:?}");

    // It moved after the check: the read answers nothing from the new page.
    host.moves_during_read("shop", OTHER, &[]);
    let (_, card) = ask(&s, "Moves during the read").await?;
    assert!(card.is_none(), "{card:?}");
    let changed = results(&s)
        .into_iter()
        .rfind(|value| value["reason"] == "devtools_page_changed")
        .expect("the model is told the tab moved");
    assert_eq!(changed["site"], "other.test", "{changed}");
    assert!(changed["untrusted_content"].is_null(), "{changed}");
    assert!(!results(&s).iter().any(|value| value["read"] == "network"));

    // The site's own traffic showed a sign-in between check and read.
    host.moves_during_read("second", SHOP, &["api.example.test"]);
    let (_, card) = ask(&s, "Signed in during the read").await?;
    assert!(card.is_none(), "{card:?}");
    let changed = results(&s)
        .into_iter()
        .rfind(|value| value["reason"] == "devtools_page_changed")
        .unwrap();
    assert_eq!(changed["place"], "signed_in", "{changed}");
    assert_no_secrets(&model_text(&s));

    // From now on it reads as signed in, whatever was allowed before.
    let (id, card) = ask(&s, "Now signed in").await?;
    let card = card.expect("a signed-in tab asks, past the site grant");
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["browser_mode"], "signed_in", "{card}");
    assert_eq!(operation["allow_conversation"], false, "{card}");
    allow(&s, &id, &card, "once").await?;
    let newest = newest_read(&s);
    assert!(newest["untrusted_content"]["entries"][0]["response_headers"].is_null());

    // It moved while the card was up: that yes does not apply to the new page.
    let before = host.reads().len();
    let (id, card) = ask(&s, "Moves while asking").await?;
    let card = card.expect("asks");
    host.navigate("third", BLOG).await?;
    allow(&s, &id, &card, "once").await?;
    assert_eq!(host.reads().len(), before, "no read ran under a stale yes");
    assert!(
        results(&s)
            .iter()
            .any(|value| value["error"] == "authority_request_identity_mismatch")
    );
    s.finish().await
}

#[tokio::test]
async fn full_access_skips_the_site_card_but_not_the_signed_in_one() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-FULL")?
        .stub_cassette(cassette(&[
            turn("Read the shop", vec![read("shop", "console")]),
            turn("Read the account", vec![read("acct", "console")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[("shop", "signed_out", SHOP), ("acct", "signed_in", ACCOUNT)],
        Some("bank.test"),
    )
    .await?;
    let (_, card) = ask(&s, "Read the shop").await?;
    assert!(card.is_none(), "{card:?}");
    let (id, card) = ask(&s, "Read the account").await?;
    allow(&s, &id, &card.expect("signed-in reads always ask"), "once").await?;
    assert_eq!(host.reads().len(), 2);
    s.finish().await
}

#[tokio::test]
async fn there_is_no_way_to_run_a_script() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let catalog = butler_core::tool_catalog::load().unwrap();
    let names: Vec<&str> = catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"browser_devtools"));
    for name in names.iter().filter(|name| name.contains("browser")) {
        for word in ["eval", "script", "execute", "javascript"] {
            assert!(!name.contains(word), "{name}");
        }
    }
    let definition = &catalog["rawDefinitions"]["browser_devtools"];
    let mut properties: Vec<&String> = definition["parameters"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    properties.sort();
    assert_eq!(
        properties,
        ["offset", "only_failed", "read", "selector", "tab"]
    );
    assert_eq!(definition["parameters"]["additionalProperties"], false);
    assert_eq!(
        definition["parameters"]["properties"]["read"]["enum"],
        json!(["console", "network", "dom"])
    );

    let smuggled = call(
        "browser_devtools",
        json!({"tab":"made","read":"console","expression":"alert(1)","script":"alert(1)",
            "expect":{"place":"signed_in","site":"forged.test"}}),
    );
    let s = Setup::new("BROWSER-DEVTOOLS-NO-SCRIPT")?
        .stub_cassette(cassette(&[turn("Smuggle a script", vec![smuggled])])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[("made", "signed_out", "http://127.0.0.1:9/__o/x/index.html")],
        None,
    )
    .await?;
    let (_, card) = ask(&s, "Smuggle a script").await?;
    assert!(card.is_none(), "{card:?}");
    let frames = host.frames_text();
    assert!(!frames.contains("alert(1)"), "{frames}");
    assert!(!frames.contains("forged.test"), "{frames}");
    s.finish().await
}
