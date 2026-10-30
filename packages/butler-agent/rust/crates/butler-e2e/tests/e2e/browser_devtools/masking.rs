//! Masking across the shapes values come in, through the real tool path.
use super::{Host, SHOP, ask, assert_no_secrets, call, cassette, model_text, read, results, turn};
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

/// Every shape of value a host can report: credentials never pass, and ordinary
/// facts do.
#[tokio::test]
async fn secrets_stay_masked_whatever_shape_they_come_in() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let calls = vec![
        read("shop", "console"),
        read("shop", "network"),
        read("shop", "dom"),
        read("pay", "dom"),
        read("lan", "console"),
    ];
    let s = Setup::new("BROWSER-DEVTOOLS-MASKING")?
        .stub_cassette(cassette(&[turn("Read the pages", calls)])?)
        .start()
        .await?;
    let _host = Host::attach(
        &s,
        &[
            ("shop", "signed_out", SHOP),
            ("pay", "signed_out", "https://checkout.stripe.com/c/pay"),
            ("lan", "signed_out", "http://192.168.0.2/"), // privacy-hygiene: allow-private-ip (LAN-denial fixture)
        ],
        None,
    )
    .await?;
    let (_, card) = ask(&s, "Read the pages").await?;
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
    let lines = console["untrusted_content"]["entries"].to_string();
    assert!(
        lines.contains("status: 500"),
        "ordinary facts stay: {lines}"
    );
    assert!(lines.contains("TokenExpiredError: jwt expired"), "{lines}");
    assert!(lines.contains("AuthError: login failed"), "{lines}");
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
    assert_eq!(row(3), "https://checkout.stripe.com/pay/cs?x=1", "{rows}");
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
    assert_eq!(
        row(6),
        "https://a.example.test/in?next=[masked]&go=https%3A%2F%2Fy.test%2Fhome",
        "{rows}"
    );
    assert_eq!(
        row(7),
        "https://a.example.test/in?pass=[masked]&pw=[masked]&passcode=[masked]&hmac=[masked]&lasso=keep",
        "{rows}"
    );
    assert_eq!(
        row(8),
        "https://a.example.test/in?card=[masked]&cvc=[masked]&cvv=[masked]&pan=[masked]&company=keep",
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
    assert!(html.contains("value=\"plain-button\""), "{html}");
    assert!(html.contains("data-user=\"plain-user\""), "{html}");
    assert!(html.contains("href=\"/save?token=[masked]&q=1\""), "{html}");
    assert!(html.contains("[40 chars not read]"), "{html}");

    // A provider's own checkout page reads like any other, its fields hidden.
    let reads = outputs
        .iter()
        .filter(|value| value["read"] == "dom")
        .count();
    assert_eq!(reads, 2, "{outputs:?}");
    assert!(
        outputs
            .iter()
            .any(|value| value["reason"] == "navigation_denied"),
        "{outputs:?}"
    );
    s.finish().await
}

/// A selector that could reveal a masked value never reaches a page, and one
/// the browser can't parse comes back refused.
#[tokio::test]
async fn selectors_are_checked_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let dom = |selector: &str| {
        call(
            "browser_devtools",
            json!({"tab":"shop","read":"dom","selector":selector}),
        )
    };
    let long = "a".repeat(201);
    let good = r#"form#login input[type="text"][name=q]:not([value])"#;
    let s = Setup::new("BROWSER-DEVTOOLS-SELECTOR")?
        .stub_cassette(cassette(&[
            turn(
                "Bad selector",
                vec![
                    dom("[["),
                    dom(&long),
                    dom(r#"input[name=csrf][value^="abc"]"#),
                    dom("[VALUE*=a]"),
                    dom(r"[v\61lue^=a]"),
                    dom("form:has([data-token$=a])"),
                    dom("[*|value=a]"),
                    dom("meta[content^=a]"),
                    dom(r#"a[href*="token=abc"]"#),
                ],
            ),
            turn("Good selector", vec![dom(good)]),
        ])?)
        .start()
        .await?;
    let host = Host::attach(&s, &[("shop", "signed_out", SHOP)], None).await?;
    let (_, card) = ask(&s, "Bad selector").await?;
    assert!(card.is_none(), "{card:?}");
    let refused = results(&s)
        .iter()
        .filter(|value| value["reason"] == "invalid_selector")
        .count();
    assert_eq!(refused, 9);
    assert_eq!(
        host.reads().len(),
        1,
        "only the unparsable one reaches a page"
    );
    let (_, card) = ask(&s, "Good selector").await?;
    assert!(card.is_none(), "{card:?}");
    assert_eq!(host.reads()[1]["selector"], good);
    s.finish().await
}
