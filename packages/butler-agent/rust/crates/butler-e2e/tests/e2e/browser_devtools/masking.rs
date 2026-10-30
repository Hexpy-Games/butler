//! Masking across the shapes values come in, through the real tool path.
use super::{
    ACCOUNT, Host, OTHER, SHOP, allow, ask, assert_no_secrets, cassette, model_text, newest_read,
    read, results, turn,
};
use butler_e2e::e2e::{HarnessError, scenario::Setup};

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
    let headers = &rows[0]["response_headers"];
    assert_eq!(headers["Content-Type"], "application/json", "{rows}");
    for name in ["Set-Cookie", "Authorization", "X-CSRF-Token"] {
        assert_eq!(headers[name], "[masked]", "{rows}");
    }
    assert!(!rows.to_string().contains("request_body"), "{rows}");

    let html = read_of("dom")["untrusted_content"]["html"]
        .as_str()
        .unwrap();
    assert!(html.contains("value=\"plain-nick\""), "{html}");
    assert!(html.contains("data-user=\"plain-user\""), "{html}");
    assert!(html.contains("href=\"/save?token=[masked]&q=1\""), "{html}");
    assert!(html.contains("[40 chars not read]"), "{html}");

    let refused = |reason: &str| outputs.iter().any(|value| value["reason"] == reason);
    assert!(refused("payment_page"), "{outputs:?}");
    assert!(refused("navigation_denied"), "{outputs:?}");

    let (id, card) = ask(&s, "Read signed in").await?;
    allow(&s, &id, &card.expect("signed-in asks"), "once").await?;
    let signed_in = newest_read(&s);
    let html = signed_in["untrusted_content"]["html"].as_str().unwrap();
    for plain in ["plain-nick", "plain-user"] {
        assert!(!html.contains(plain), "{plain}: {html}");
    }
    assert!(html.contains("class=\"card\""), "{html}");
    assert!(html.contains("q=[masked]"), "{html}");
    assert_no_secrets(&model_text(&s));
    s.finish().await
}
