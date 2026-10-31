//! Browser approval scope: on ask-first and Auto, browsing a public site (a
//! consent banner, search, filters, tabs, links) never asks; a POST submit in
//! a signed-in tab or a step the model declares as committing asks once;
//! payment steps keep their exact card. Ask-always still asks for every batch;
//! full access asks only at payment.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
pub(super) mod host;
mod staging;
mod upload;
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, Scenario, Setup},
};
use host::{Host, call};
use serde_json::{Value, json};
use std::time::Duration;

const BROWSE: &str = "Browse the public catalog";
const POST: &str = "Post my comment";
const SEND: &str = "Send the message";
const PAY: &str = "Pay for the order";

#[tokio::test]
async fn ask_first_browses_freely_and_asks_only_to_commit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browses_freely_and_asks_only_to_commit("BROWSER-APPROVAL-SCOPE", Access::AskExceptReads).await
}

#[tokio::test]
async fn auto_browses_freely_and_asks_only_to_commit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    browses_freely_and_asks_only_to_commit("BROWSER-APPROVAL-AUTO", Access::Auto).await
}

async fn browses_freely_and_asks_only_to_commit(
    scenario: &str,
    access: Access,
) -> Result<(), HarnessError> {
    let s = Setup::new(scenario)?
        .access(access)
        .stub_cassette(host::cassette(&[browse(), post(), send(), pay()])?)
        .start()
        .await?;
    let host = Host::attach(&s).await?;

    let (_, card) = ask(&s, BROWSE).await?;
    assert!(card.is_none(), "browsing asked: {card:?}");
    let acts = host.acts();
    assert_eq!(acts.len(), 3, "every browsing batch dispatched");
    assert!(acts.iter().all(|args| args["commit_cleared"] == false));
    // Collecting an image from an owned tab is browsing too: ask-first offers it.
    assert!(
        host.ops().iter().any(|op| op == "tab.image_collect"),
        "{:?}",
        host.ops()
    );

    let (id, card) = ask(&s, POST).await?;
    let card = card.expect("a signed-in POST submit asks");
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["tool"], "browser_act", "{card}");
    assert_eq!(
        operation["browser_tab"], "acct",
        "exact thumbnail tab binding"
    );
    assert_eq!(operation["browser_mode"], "signed_in", "{card}");
    assert_eq!(operation["browser_steps"][0]["name"], "Post", "{card}");
    assert_eq!(card["approval"]["risk"], "medium", "{card}");
    let acts = host.acts();
    assert_eq!(acts.len(), 4, "typing the comment ran without asking");
    assert_eq!(acts[3]["commit_cleared"], false, "{}", acts[3]);
    allow(&s, &id, &card).await?;
    assert_eq!(host.acts()[4]["commit_cleared"], true);

    let (id, card) = ask(&s, SEND).await?;
    let card = card.expect("a declared commit asks");
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["browser_mode"], "signed_out", "{card}");
    assert_eq!(operation["browser_steps"][0]["name"], "Send", "{card}");
    allow(&s, &id, &card).await?;
    assert_eq!(host.acts()[5]["commit_cleared"], true);

    let (id, card) = ask(&s, PAY).await?;
    let card = card.expect("the payment gate is unchanged");
    assert_eq!(card["approval"]["risk"], "high", "{card}");
    assert_eq!(card["approval"]["operation"]["allow_conversation"], false);
    allow(&s, &id, &card).await?;
    assert_eq!(host.acts().len(), 7);
    s.finish().await
}

#[tokio::test]
async fn ask_always_still_asks_for_a_plain_click() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-APPROVAL-ALWAYS")?
        .access(Access::AskAlways)
        .stub_cassette(host::cassette(&[click()])?)
        .start()
        .await?;
    let host = Host::attach(&s).await?;
    let (id, card) = ask(&s, BROWSE).await?;
    let card = card.expect("ask-always asks for every batch");
    assert_eq!(card["approval"]["risk"], "medium", "{card}");
    assert_eq!(card["approval"]["operation"]["allow_conversation"], true);
    assert_eq!(host.acts(), Vec::<Value>::new());
    assert!(card["approval"]["operation"]["allow_site"].is_null());
    let reference = card["request_ref"].as_str().unwrap();
    let invalid =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"site"}),
        )
        .await?;
    assert_eq!(
        invalid.body["error"]["code"], "site_scope_invalid",
        "{}",
        invalid.text
    );
    allow(&s, &id, &card).await?;
    assert_eq!(host.acts().len(), 1);
    s.finish().await
}

#[tokio::test]
async fn full_access_asks_only_at_payment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-APPROVAL-FULL")?
        .stub_cassette(host::cassette(&[post(), pay()])?)
        .start()
        .await?;
    let host = Host::attach(&s).await?;
    let (_, card) = ask(&s, POST).await?;
    assert!(card.is_none(), "full access asked to commit: {card:?}");
    assert!(
        host.acts()
            .iter()
            .all(|args| args["commit_cleared"] == true)
    );
    let (id, card) = ask(&s, PAY).await?;
    let card = card.expect("payment still asks on full access");
    assert_eq!(card["approval"]["risk"], "high", "{card}");
    allow(&s, &id, &card).await?;
    assert_eq!(host.acts().len(), 3);
    s.finish().await
}

/// A payment widget's frame asks however its host is written, on the tier that
/// asks for nothing else; a host that only looks alike does not.
#[tokio::test]
async fn a_payment_frame_asks_with_a_trailing_dot_or_other_case() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let click = |text: &str, target: &str| -> Turn {
        (
            text.into(),
            vec![act("pub", vec![step("click", target, "")])],
        )
    };
    let s = Setup::new("BROWSER-APPROVAL-PAYMENT-HOST")?
        .stub_cassette(host::cassette(&[
            click("Pay on the dotted host", "e10"),
            click("Pay on the upper-case host", "e11"),
            click("Click on the lookalike host", "e12"),
        ])?)
        .start()
        .await?;
    let host = Host::attach(&s).await?;
    for text in ["Pay on the dotted host", "Pay on the upper-case host"] {
        let before = host.acts().len();
        let (id, card) = ask(&s, text).await?;
        let card = card.unwrap_or_else(|| panic!("{text}: slipped past the payment gate"));
        assert_eq!(card["approval"]["risk"], "high", "{card}");
        assert_eq!(
            host.acts().len(),
            before,
            "{text}: nothing runs before the answer"
        );
        allow(&s, &id, &card).await?;
        assert_eq!(host.acts().len(), before + 1, "{text}");
    }
    let (_, card) = ask(&s, "Click on the lookalike host").await?;
    assert!(card.is_none(), "{card:?}");
    s.finish().await
}

type Turn = (String, Vec<Value>);

fn act(tab: &str, steps: Vec<Value>) -> Value {
    let mut arguments = json!({"tab":tab,"observation":"obs-1"});
    arguments["steps"] = Value::Array(steps);
    call("browser_act", arguments)
}

fn step(action: &str, target: &str, value: &str) -> Value {
    let mut step = json!({"action": action});
    if !target.is_empty() {
        step["ref"] = json!(target);
    }
    if !value.is_empty() {
        step["value"] = json!(value);
    }
    step
}

fn browse() -> Turn {
    let search = vec![
        step("click", "e2", ""),
        step("type", "", "wool coat"),
        step("press", "", "Enter"),
    ];
    let filters = vec![
        step("select", "e3", "m"),
        step("click", "e5", ""),
        step("scroll", "e4", "600"),
        step("click", "e4", ""),
    ];
    let observe = call("browser_observe", json!({"tab":"pub","look":"never"}));
    let banner = act("pub", vec![step("click", "e1", "")]);
    let image = call(
        "image_collect",
        json!({"tab":"pub","url":"https://shop.example.test/coat.jpg"}),
    );
    let calls = vec![
        observe,
        banner,
        act("pub", search),
        act("pub", filters),
        image,
    ];
    (BROWSE.into(), calls)
}

fn click() -> Turn {
    (
        BROWSE.into(),
        vec![act("pub", vec![step("click", "e1", "")])],
    )
}

fn post() -> Turn {
    let comment = vec![step("click", "e6", ""), step("type", "", "Warm and light.")];
    let submit = act("acct", vec![step("click", "e7", "")]);
    (POST.into(), vec![act("acct", comment), submit])
}

fn send() -> Turn {
    let mut declared = step("click", "e8", "");
    declared["commits"] = json!(true);
    (SEND.into(), vec![act("pub", vec![declared])])
}

fn pay() -> Turn {
    (PAY.into(), vec![act("pub", vec![step("click", "e9", "")])])
}

/// Sends `text`; returns the turn and the approval card it raised, or None
/// when the turn delivered without asking.
async fn ask(s: &Scenario, text: &str) -> Result<(String, Option<Value>), HarnessError> {
    let id = s.gw.say_turn("general", text).await?;
    let states = ["waiting_for_form", "delivered", "failed"];
    for _ in 0..100 {
        let turn =
            s.gw.wait_turn("general", &id, &states, Duration::from_secs(30))
                .await?;
        match turn_state(&turn) {
            "delivered" => return Ok((id, None)),
            "failed" => panic!("{turn}\n{}", s.agent.logs()),
            _ => {}
        }
        if let Some(card) = s.gw.approval_requests("general").await?.into_iter().next() {
            return Ok((id, Some(card)));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("turn neither delivered nor asked");
}

/// Allows the card once and waits for the turn to deliver.
async fn allow(s: &Scenario, id: &str, card: &Value) -> Result<(), HarnessError> {
    let reference = card["request_ref"].as_str().unwrap();
    let response =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(response.status, 202, "{}", response.text);
    let done =
        s.gw.wait_terminal("general", id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    Ok(())
}
