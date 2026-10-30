//! Masking across the shapes values come in, through the real tool path.
use super::super::browser_approval::host::call;
use super::{
    ACCOUNT, Host, OTHER, SHOP, allow, ask, assert_no_secrets, cassette, model_text, newest_read,
    read, results, turn,
};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Access, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::json;

/// Every shape of value a host can report, on a tab read in the clear and on a
/// signed-in one: credentials never pass, and ordinary facts do where allowed.
#[tokio::test]
async fn secrets_stay_masked_whatever_shape_they_come_in() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let calls = vec![
        read("shop", "console"),
        read("shop", "network"),
        read("shop", "dom"),
        read("other", "console"),
        read("pay", "console"),
        read("lan", "console"),
        read("pay_dot", "console"),
    ];
    let s = Setup::new("BROWSER-DEVTOOLS-MASKING")?
        .stub_cassette(cassette(&[
            turn("Read in the clear", calls),
            turn("Read signed in", vec![read("acct", "dom")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[
            ("shop", "signed_out", SHOP),
            ("other", "signed_out", OTHER),
            ("pay", "signed_out", "https://checkout.stripe.com/c/pay"),
            (
                "pay_dot",
                "signed_out",
                "https://checkout.stripe.com./c/pay",
            ),
            ("lan", "signed_out", "http://192.168.0.2/"), // privacy-hygiene: allow-private-ip (LAN-denial fixture)
            ("acct", "signed_in", ACCOUNT),
        ],
        Some("bank.test"),
    )
    .await?;
    // A credential on another site says nothing about this one.
    host.moves_during_read("other", OTHER, &["api.example.test"]);
    let (_, card) = ask(&s, "Read in the clear").await?;
    assert!(card.is_none(), "{card:?}");
    let text = model_text(&s);
    assert_no_secrets(&text);
    let outputs = results(&s);
    let read_of = |what: &str| {
        outputs
            .iter()
            .find(|value| value["read"] == what)
            .unwrap_or_else(|| panic!("no {what} read"))
    };

    let console = read_of("console");
    assert_eq!(console["place"], "signed_out", "{console}");
    let lines = console["untrusted_content"]["entries"].to_string();
    assert!(
        lines.contains("status: 500"),
        "ordinary facts stay: {lines}"
    );
    assert!(lines.contains(" left"), "{lines}");
    assert!(lines.contains("Bearer [masked]"), "{lines}");
    assert!(lines.contains("cookie: [masked]"), "{lines}");
    assert!(
        lines.contains("see [masked]"),
        "an unreadable URL is not shown: {lines}"
    );
    assert!(lines.contains("javascript:["), "{lines}");

    let rows = &read_of("network")["untrusted_content"]["entries"];
    let row = |index: usize| rows[index]["url"].as_str().unwrap();
    assert!(
        row(0).contains("access_token=[masked]") && row(0).contains("q=plain-query"),
        "{rows}"
    );
    assert_eq!(
        row(1),
        "https://cdn.example.test/a.js?v=1#id_token=[masked]",
        "{rows}"
    );
    assert_eq!(
        row(2),
        "https://app.example.test/r/abcdefghijklmnopqrstuvwx1234?q=coat#top",
        "{rows}"
    );
    assert_eq!(row(3), "https://checkout.stripe.com/[masked]", "{rows}");
    assert_eq!(
        row(4),
        "https://sso.example.test/in?ticket=[masked]&sso=[masked]&magic=[masked]&keep=1",
        "{rows}"
    );
    assert_eq!(
        row(5),
        "https://matrix.example.test/p?a=1;token=[masked];b=2",
        "{rows}"
    );
    let headers = &rows[0]["response_headers"];
    assert_eq!(headers["Content-Type"], "application/json", "{rows}");
    for name in ["Set-Cookie", "Authorization", "X-CSRF-Token"] {
        assert_eq!(headers[name], "[masked]", "{rows}");
    }
    assert!(!rows.to_string().contains("request_body"), "{rows}");

    let html = read_of("dom")["untrusted_content"]["html"]
        .as_str()
        .unwrap();
    assert!(
        !html.contains("plain-nick"),
        "a typed value stays out: {html}"
    );
    assert!(html.contains("value=\"plain-radio\""), "{html}");
    assert!(html.contains("data-user=\"plain-user\""), "{html}");
    assert!(html.contains("href=\"/save?token=[masked]&q=1\""), "{html}");
    assert!(html.contains("[40 chars not read]"), "{html}");

    let refused = |reason: &str| outputs.iter().any(|value| value["reason"] == reason);
    let payment = outputs
        .iter()
        .filter(|value| value["reason"] == "payment_page");
    assert_eq!(
        payment.count(),
        2,
        "with or without a trailing dot: {outputs:?}"
    );
    assert!(refused("navigation_denied"), "{outputs:?}");

    let (id, card) = ask(&s, "Read signed in").await?;
    allow(&s, &id, &card.expect("signed-in asks"), "once").await?;
    let signed_in = newest_read(&s);
    let html = signed_in["untrusted_content"]["html"].as_str().unwrap();
    for plain in ["plain-nick", "plain-user", "plain-radio"] {
        assert!(!html.contains(plain), "{plain}: {html}");
    }
    assert!(html.contains("class=\"card\""), "{html}");
    assert!(html.contains("q=[masked]"), "{html}");
    assert_no_secrets(&model_text(&s));
    s.finish().await
}

/// A page moved a user's tab to a loopback service: the rule that local pages
/// don't ask is about what the user opened. This one asks, every time, masked.
#[tokio::test]
async fn a_page_that_moved_the_tab_to_loopback_asks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-DEVTOOLS-LOOPBACK-MOVE")?
        .access(Access::FullAccess)
        .stub_cassette(cassette(&[
            turn("Read the service", vec![read("moved", "dom")]),
            turn("Read it again", vec![read("moved", "dom")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[(
            "moved",
            "signed_out",
            "http://localhost:2375/containers/json",
        )],
        None,
    )
    .await?;
    host.arrived_by_page("moved");
    let (id, card) = ask(&s, "Read the service").await?;
    let card = card.expect("even full access asks");
    let operation = &card["approval"]["operation"];
    assert_eq!(operation["targets"][0], "localhost:2375", "{card}");
    assert_eq!(operation["browser_mode"], "signed_out", "{card}");
    assert_eq!(operation["allow_conversation"], false, "{card}");
    assert_eq!(card["approval"]["risk"], "medium", "{card}");
    allow(&s, &id, &card, "once").await?;
    let reply = newest_read(&s);
    let html = reply["untrusted_content"]["html"].as_str().unwrap();
    assert!(!html.contains("plain-user"), "read masked: {html}");
    let (id, card) = ask(&s, "Read it again").await?;
    allow(&s, &id, &card.expect("every time"), "once").await?;
    s.finish().await
}

/// A selector the browser cannot parse never reaches a card; one it can is
/// labelled there; the schedule's sign-in switch holds on a local page too.
#[tokio::test]
async fn selectors_are_checked_first_and_schedules_keep_their_switch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let dom = |selector: &str| {
        call(
            "browser_devtools",
            json!({"tab":"shop","read":"dom","selector":selector}),
        )
    };
    let long = "a".repeat(201);
    let s = Setup::new("BROWSER-DEVTOOLS-SELECTOR")?
        .access(Access::AskExceptReads)
        .stub_cassette(cassette(&[
            turn("Bad selector", vec![dom("[["), dom(&long)]),
            turn("Good selector", vec![dom("form#login")]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[
            ("shop", "signed_out", SHOP),
            ("dev_signed_in", "signed_in", "http://127.0.0.1:3000/"),
        ],
        None,
    )
    .await?;
    let (_, card) = ask(&s, "Bad selector").await?;
    assert!(card.is_none(), "no card for a bad selector: {card:?}");
    let refused = results(&s)
        .iter()
        .filter(|value| value["reason"] == "invalid_selector")
        .count();
    assert_eq!(refused, 2);
    assert!(host.reads().is_empty());
    let (id, card) = ask(&s, "Good selector").await?;
    let card = card.expect("a good one asks");
    assert_eq!(
        card["approval"]["operation"]["targets"][2], "form#login",
        "{card}"
    );
    allow(&s, &id, &card, "once").await?;

    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let reply = admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(
                json!({"op":"tab.devtools_place","session":"general","tab":"dev_signed_in",
                "args":{},"schedule_browser":{"signin":false}}),
            ),
            &[],
        )
        .await?;
    assert_eq!(
        reply.body["reason"], "schedule_signin_off",
        "{}",
        reply.text
    );
    s.finish().await
}
