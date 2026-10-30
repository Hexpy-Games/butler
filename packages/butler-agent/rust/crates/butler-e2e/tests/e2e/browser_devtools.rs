//! `browser_devtools`: read-only console, network and DOM reads through the
//! real tool path and gateway, with a scripted browser host. A read like
//! `browser_observe`: no card of its own, behind the same signed-in site
//! grants, and masked one way on every tab.
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

async fn allow(s: &Scenario, id: &str, card: &Value) -> Result<(), HarnessError> {
    let reference = card["request_ref"].as_str().unwrap();
    let response =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({ "scope": "once" }),
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

fn assert_no_secrets(text: &str) {
    let leaked: Vec<&&str> = SECRETS
        .iter()
        .filter(|secret| text.contains(**secret))
        .collect();
    assert!(leaked.is_empty(), "leaked: {leaked:?}");
}

/// The strictest tier, and pages of every kind: a read asks nothing.
#[tokio::test]
async fn reads_never_ask() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let reads = vec![
        read("made", "console"),
        read("preview", "network"),
        read("dev", "dom"),
        read("dev_signed_in", "network"),
        read("shop", "dom"),
        read("identity", "console"),
    ];
    let s = Setup::new("BROWSER-DEVTOOLS-READS")?
        .access(Access::AskAlways)
        .stub_cassette(cassette(&[turn("Read the pages", reads)])?)
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
            ("shop", "signed_out", SHOP),
            (
                "identity",
                "signed_in",
                "https://accounts.google.com/signin",
            ),
        ],
        None,
    )
    .await?;
    let (_, card) = ask(&s, "Read the pages").await?;
    assert!(card.is_none(), "a read asked: {card:?}");
    assert_eq!(host.reads().len(), 6, "every read dispatched");
    let outputs = results(&s);
    let read = outputs
        .iter()
        .find(|value| value["schema"] == "butler.browser-devtools.v1")
        .expect("a DevTools read reached the model");
    assert_eq!(read["untrusted_content"]["kind"], "web_page_data");
    assert_no_secrets(&model_text(&s));
    s.finish().await
}

/// A read changes nothing, so the read-only tier allows it.
#[tokio::test]
async fn the_read_only_tier_reads() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-READ-ONLY")?
        .stub_cassette(cassette(&[turn(
            "Read in read-only",
            vec![read("shop", "dom")],
        )])?)
        .start()
        .await?;
    let host = Host::attach(&s, &[("shop", "signed_out", SHOP)], None).await?;
    let response =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","text":"Read in read-only",
                "client_message_id":"devtools-read-only","access_mode":"read_only"}),
        )
        .await?;
    let turn = s.gw.accepted_turn(response.data()).await?;
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    assert_eq!(host.reads().len(), 1);
    s.finish().await
}

#[tokio::test]
async fn a_read_on_a_granted_signed_in_site_asks_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-GRANTED")?
        .access(Access::AskAlways)
        .stub_cassette(cassette(&[turn(
            "Read the account",
            vec![read("acct", "dom")],
        )])?)
        .start()
        .await?;
    let host = Host::attach(&s, &[("acct", "signed_in", ACCOUNT)], Some("bank.test")).await?;
    let (_, card) = ask(&s, "Read the account").await?;
    assert!(card.is_none(), "{card:?}");
    assert_eq!(host.reads().len(), 1);
    assert_no_secrets(&model_text(&s));
    s.finish().await
}

/// Observe on the same tab raises the same site card; the read follows it.
#[tokio::test]
async fn a_signed_in_site_with_no_grant_follows_observe() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-NO-GRANT")?
        .stub_cassette(cassette(&[
            turn(
                "Observe the account",
                vec![call(
                    "browser_observe",
                    json!({"tab":"seen","look":"never"}),
                )],
            ),
            turn("Read the account", vec![read("acct", "console")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[
            ("seen", "signed_in", "https://app.first.test/home"),
            ("acct", "signed_in", ACCOUNT),
        ],
        None,
    )
    .await?;
    let (id, observed) = ask(&s, "Observe the account").await?;
    let observed = observed.expect("observe asks for the site");
    let (read_id, card) = {
        allow(&s, &id, &observed).await?;
        ask(&s, "Read the account").await?
    };
    let card = card.expect("so does a read");
    let operation = &card["approval"]["operation"];
    assert_eq!(
        operation["tool"], observed["approval"]["operation"]["tool"],
        "{card}"
    );
    assert_eq!(operation["targets"], json!(["bank.test"]), "{card}");
    assert_eq!(host.reads().len(), 0, "nothing is read before the answer");
    allow(&s, &read_id, &card).await?;
    assert_eq!(host.reads().len(), 1);
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
        json!({"tab":"made","read":"console","expression":"alert(1)","script":"alert(1)","policy":"forged"}),
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
    assert!(!frames.contains("forged"), "{frames}");
    s.finish().await
}
