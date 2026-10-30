//! `tab.devtools` on a real browser: console errors, request rows and the DOM
//! of a Butler-made page, read without a card and with secret fields masked.
//! Capture ends with the document: a reload does not repeat the old entries.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use super::support::{admin, call, open, publish_as, selected, setup};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>DevTools fixture</title>
<meta name="csrf-token" content="SECRET-META">
<form action="./save?token=SECRET-QUERY"><input type="password" name="pw" value="SECRET-PASSWORD">
<input type="hidden" name="nonce" value="SECRET-HIDDEN"><input name="q" value="SECRET-TYPED"><input name="cardNumber" value="SECRET-CARD">
<input type="radio" name="size" value="plain-radio"></form>
<h1 onclick="steal('SECRET-HANDLER')">Fixture heading</h1>
<script>console.error("fixture failed token=SECRET-CONSOLE");fetch("./missing.json?access_token=SECRET-QUERY");</script>"#;

/// A page whose every list is longer than one host reply may carry.
pub(super) const LONG_PAGE: &str = r##"<!doctype html><meta charset="utf-8"><title>Long fixture</title><main id="all"></main>
<section id="end"><h2>마지막 구역</h2></section>
<script>
for (let i = 0; i < 260; i++) console.error(`오류 ${i} ${"한".repeat(3000)}`);
const all = document.querySelector("#all");
for (let i = 0; i < 9000; i++) { const row = document.createElement("div"); row.className = "row-" + i; row.textContent = "한글 내용 ".repeat(30); all.append(row); }
fetch("./signed.json", { headers: { Authorization: "Bearer SECRET-HEADER" } }).catch(() => {});
const ctrl = document.createElement("section"); ctrl.id = "ctrl";
for (let i = 0; i < 300; i++) { const row = document.createElement("p"); row.textContent = "\u0001".repeat(400); ctrl.append(row); }
document.body.append(ctrl);
for (let i = 0; i < 620; i++) fetch(`./gone-${i}.json?${"q".repeat(1500)}=1`).catch(() => {});
</script>"##;

const SECRETS: &[&str] = &[
    "SECRET-META",
    "SECRET-QUERY",
    "SECRET-PASSWORD",
    "SECRET-HIDDEN",
    "SECRET-HANDLER",
    "SECRET-CONSOLE",
    "SECRET-TYPED",
    "SECRET-CARD",
];

/// A page with its own cookie; a login shows in the store whoever wrote it.
pub(super) const COOKIE_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Cookie fixture</title><p>signed in</p>
<script>document.cookie = "session=SECRET-COOKIE; path=/";</script>"#;

/// A dev server for what a preview can show: a request left hanging across a
/// navigation, requests that never finish, and a page leaving http.
pub(super) const SERVER: &str = r#"
const port = Number(process.argv[2]);
const page = body => new Response(`<!doctype html><meta charset="utf-8"><title>t</title>${body}`, { headers: { "content-type": "text/html" } });
Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/hang") return new Promise(() => {});
  if (path === "/") return page(`<script>fetch("/hang?from=OLD_DOCUMENT");setTimeout(() => { location.href = "/next"; }, 300);</script>`);
  if (path === "/next") return page(`<script>fetch("/own");setTimeout(() => { location.href = "/many"; }, 2500);</script>`);
  if (path === "/many") return page(`<script>for (let i = 0; i < 3000; i++) fetch("/hang?i=" + i);setTimeout(() => { location.href = "about:blank"; }, 4000);</script>`);
  return page("<p>ok</p>");
} });
"#;

async fn read(admin: &AdminClient, tab: &Value, args: Value) -> Result<Value, HarnessError> {
    let mut args = args;
    args["expect"] = json!({"place":"local","site":""});
    // A page on its way somewhere says so; ask again once it has arrived.
    let mut reply = Value::Null;
    for _ in 0..20 {
        reply = call(admin, "general", "tab.devtools", tab, args.clone()).await?;
        if reply["reason"] != "devtools_page_changed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(reply["status"], "ok", "{reply}");
    assert_eq!(reply["place"], "local", "{reply}");
    assert_eq!(
        reply["untrusted_content"]["kind"], "web_page_data",
        "{reply}"
    );
    let text = reply.to_string();
    for secret in SECRETS {
        assert!(!text.contains(secret), "{secret} leaked: {text}");
    }
    Ok(reply)
}

/// The rows of a read, waiting out the page's own late requests.
async fn entries_with(
    admin: &AdminClient,
    tab: &Value,
    what: &str,
    needle: &str,
) -> Result<Value, HarnessError> {
    for _ in 0..50 {
        let reply = read(admin, tab, json!({"read":what})).await?;
        if reply["untrusted_content"]["entries"]
            .to_string()
            .contains(needle)
        {
            return Ok(reply);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{what} never showed {needle}");
}

#[tokio::test]
async fn a_butler_page_reads_its_console_network_and_dom() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !selected() {
        return Ok(());
    }
    let s = setup("HEADLESS-DEVTOOLS")?.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish devtools").await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = opened["tab"].clone();

    let place = call(&admin, "general", "tab.devtools_place", &tab, json!({})).await?;
    assert_eq!(place["place"], "local", "{place}");
    assert_eq!(place["masked"], false, "{place}");

    let console = entries_with(&admin, &tab, "console", "fixture failed").await?;
    let first = &console["untrusted_content"]["entries"][0];
    assert_eq!(first["level"], "error", "{console}");
    assert!(
        first["text"]
            .as_str()
            .unwrap()
            .contains("fixture failed token=[masked]"),
        "{console}"
    );

    let network = entries_with(&admin, &tab, "network", "missing.json").await?;
    let rows = network["untrusted_content"]["entries"].as_array().unwrap();
    let missing = rows
        .iter()
        .find(|row| row["url"].as_str().unwrap().contains("missing.json"))
        .unwrap_or_else(|| panic!("{network}"));
    assert!(missing["status"].as_u64() >= Some(400), "{network}");
    assert!(missing["error"].is_null(), "{network}");
    assert!(
        missing["url"]
            .as_str()
            .unwrap()
            .ends_with("missing.json?access_token=[masked]"),
        "{network}"
    );
    let failed = read(&admin, &tab, json!({"read":"network","only_failed":true})).await?;
    let failed = failed["untrusted_content"]["entries"]
        .as_array()
        .unwrap()
        .clone();
    assert!(failed.iter().all(|row| row["status"].as_u64() >= Some(400)));
    assert_ne!(failed.len(), 0);

    let dom = read(&admin, &tab, json!({"read":"dom"})).await?;
    let html = dom["untrusted_content"]["html"].as_str().unwrap();
    assert!(
        html.contains("<input type=\"password\" name=\"pw\" value=\"[masked]\">"),
        "{html}"
    );
    assert!(html.contains("value=\"plain-radio\""), "{html}");
    assert!(html.contains("Fixture heading"), "{html}");
    assert!(
        html.contains("chars not read]"),
        "scripts stay unread: {html}"
    );
    assert_eq!(dom["untrusted_content"]["complete"], true, "{dom}");
    let part = read(&admin, &tab, json!({"read":"dom","selector":"h1"})).await?;
    let html = part["untrusted_content"]["html"].as_str().unwrap();
    assert!(html.starts_with("<h1"), "{html}");
    assert!(!html.contains("<form"), "{html}");
    let none = read(&admin, &tab, json!({"read":"dom","selector":"#absent"})).await?;
    assert_eq!(
        none["untrusted_content"]["selector_matched"], false,
        "{none}"
    );
    let bad = call(
        &admin,
        "general",
        "tab.devtools",
        &tab,
        json!({"read":"dom","selector":"[[","expect":{"place":"local","site":""}}),
    )
    .await?;
    assert_eq!(bad["reason"], "invalid_selector", "{bad}");

    // A read allowed for somewhere else returns nothing from here.
    let elsewhere = call(
        &admin,
        "general",
        "tab.devtools",
        &tab,
        json!({"read":"console","expect":{"place":"signed_out","site":"example.com"}}),
    )
    .await?;
    assert_eq!(elsewhere["reason"], "devtools_page_changed", "{elsewhere}");
    assert!(elsewhere["untrusted_content"].is_null(), "{elsewhere}");

    // The same page again: the old document's entries went with it.
    let observed = call(&admin, "general", "tab.observe", &tab, json!({})).await?;
    let steps = json!([{"action":"reload"}]);
    let prepare = json!({"observation":observed["obs"],"steps":steps});
    let prepared = call(&admin, "general", "tab.prepare", &tab, prepare).await?;
    let reload =
        json!({"observation":observed["obs"],"steps":steps,"prepared_steps":prepared["steps"]});
    let acted = call(&admin, "general", "tab.act", &tab, reload).await?;
    assert_eq!(acted["status"], "ok", "{acted}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let again = entries_with(&admin, &tab, "console", "fixture failed").await?;
    assert_eq!(again["untrusted_content"]["total"], 1, "{again}");
    s.finish().await
}

/// Every read of a page too long for one reply answers, and says what remains:
/// paging reaches the oldest rows, and a selector reaches what the walk left out.
#[tokio::test]
async fn a_long_page_reads_in_parts_and_says_so() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !selected() {
        return Ok(());
    }
    let s = setup("HEADLESS-DEVTOOLS-LONG")?.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish devtools long").await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = opened["tab"].clone();

    // Its own traffic carried a credential: it reads masked from here on, without a card.
    let mut masked = Value::Null;
    for _ in 0..50 {
        masked = call(&admin, "general", "tab.devtools_place", &tab, json!({})).await?;
        if masked["masked"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(masked["masked"], true, "{masked}");
    assert_eq!(masked["place"], "local", "{masked}");

    let console = entries_with(&admin, &tab, "console", "오류 259").await?;
    let data = &console["untrusted_content"];
    assert_eq!(data["total"], 200, "the newest 200 are kept");
    assert_eq!(data["dropped_oldest"], 60, "and the rest are counted");
    assert!(data["returned"].as_u64().unwrap() > 0);
    let next = data["next_offset"].clone();
    assert!(next.is_u64(), "older entries are reachable: {data}");
    let older = read(&admin, &tab, json!({"read":"console","offset":next})).await?;
    assert!(older["untrusted_content"]["returned"].as_u64().unwrap() > 0);

    tokio::time::sleep(Duration::from_secs(2)).await;
    let network = read(&admin, &tab, json!({"read":"network"})).await?;
    let data = &network["untrusted_content"];
    assert!(data["total"].as_u64().unwrap() > 100, "{}", data["total"]);
    let returned = data["returned"].as_u64().unwrap();
    assert_eq!(
        returned + data["older"].as_u64().unwrap(),
        data["total"].as_u64().unwrap()
    );

    let dom = read(&admin, &tab, json!({"read":"dom"})).await?;
    let data = &dom["untrusted_content"];
    assert_eq!(
        data["complete"], false,
        "the document is longer than a read"
    );
    assert!(
        data["total_elements"].as_u64().unwrap() >= 9000,
        "{}",
        data["total_elements"]
    );
    assert!(data["recovery"].as_str().unwrap().contains("selector"));
    let end = read(&admin, &tab, json!({"read":"dom","selector":"#end"})).await?;
    let html = end["untrusted_content"]["html"].as_str().unwrap();
    assert!(html.contains("마지막 구역"), "{html}");
    assert_eq!(end["untrusted_content"]["complete"], true, "{end}");

    // Control characters grow in JSON: the read still answers, and says it stopped.
    let ctrl = read(&admin, &tab, json!({"read":"dom","selector":"#ctrl"})).await?;
    assert_eq!(
        ctrl["untrusted_content"]["complete"], false,
        "{}",
        ctrl["untrusted_content"]["rendered_nodes"]
    );

    // The credential outlives the tab that showed it, while the context lives.
    let second = open(&admin, "general", &url).await?;
    assert_eq!(second["status"], "ok", "{second}");
    let closed = call(&admin, "general", "tab.close", &tab, json!({})).await?;
    assert_eq!(closed["status"], "ok", "{closed}");
    let kept = call(
        &admin,
        "general",
        "tab.devtools_place",
        &second["tab"],
        json!({}),
    )
    .await?;
    assert_eq!(kept["masked"], true, "{kept}");
    s.finish().await
}

/// A cookie in the store counts, with no traffic to show it, on every tab of
/// the conversation's browser context.
#[tokio::test]
async fn a_cookie_in_the_store_reads_masked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !selected() {
        return Ok(());
    }
    let s = setup("HEADLESS-DEVTOOLS-COOKIE")?.start().await?;
    let admin = admin(&s);
    let (_, plain) = publish_as(&s, "Publish devtools").await?;
    let (_, cookie) = publish_as(&s, "Publish devtools cookie").await?;
    let first = open(&admin, "general", &plain).await?;
    let place = call(
        &admin,
        "general",
        "tab.devtools_place",
        &first["tab"],
        json!({}),
    )
    .await?;
    assert_eq!(place["masked"], false, "{place}");
    let second = open(&admin, "general", &cookie).await?;
    assert_eq!(second["status"], "ok", "{second}");
    let mut seen = Value::Null;
    for _ in 0..50 {
        seen = call(
            &admin,
            "general",
            "tab.devtools_place",
            &first["tab"],
            json!({}),
        )
        .await?;
        if seen["masked"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(seen["masked"], true, "{seen}");
    s.finish().await
}

/// A preview's own cookie is not a login; a read never carries the last
/// document's requests; requests that never finish stay bounded; a page that
/// leaves http can't be reported under its old address.
#[tokio::test]
async fn a_preview_reads_only_its_current_document() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !selected() {
        return Ok(());
    }
    let setup = setup("HEADLESS-DEVTOOLS-PREVIEW")?.env(
        "PATH",
        std::env::var("PATH").expect("runner PATH is required"),
    );
    let cwd = setup.sandbox.workspace.clone();
    std::fs::write(cwd.join("server.mjs"), SERVER)?;
    let s = setup.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish devtools").await?;
    let warm = open(&admin, "warmup", &url).await?;
    assert_eq!(warm["status"], "ok", "{warm}");
    call(&admin, "warmup", "tab.close", &warm["tab"], json!({})).await?;
    let dev = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let args = json!({"agent":"devtools-agent","preview_id":"preview-devtools",
        "command":format!("bun server.mjs {dev}"),"cwd":cwd,"port":dev});
    let started = call(&admin, "general", "preview.start", &Value::Null, args).await?;
    assert_eq!(started["browser"]["status"], "ok", "{started}");
    let tab = started["browser"]["tab"].clone();

    let next = entries_with(&admin, &tab, "network", "/own").await?;
    let rows = next["untrusted_content"]["entries"].to_string();
    assert!(!rows.contains("OLD_DOCUMENT"), "{rows}");
    let place = call(&admin, "general", "tab.devtools_place", &tab, json!({})).await?;
    assert_eq!(place["place"], "local", "{place}");
    assert_eq!(
        place["masked"], false,
        "a preview's own cookie is no login: {place}"
    );

    entries_with(&admin, &tab, "network", "/hang?i=").await?;
    let mut bounded = Value::Null;
    for _ in 0..25 {
        bounded = read(&admin, &tab, json!({"read":"network"})).await?;
        let total = bounded["untrusted_content"]["total"].as_u64().unwrap();
        assert!(total <= 1000, "pending stays bounded: {total}");
        if bounded["untrusted_content"]["dropped_oldest"].as_u64() > Some(0) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let dropped = bounded["untrusted_content"]["dropped_oldest"].as_u64();
    assert!(dropped > Some(0), "what fell out is counted: {dropped:?}");

    let mut gone = Value::Null;
    for _ in 0..80 {
        gone = call(&admin, "general", "tab.devtools_place", &tab, json!({})).await?;
        if matches!(
            gone["reason"].as_str(),
            Some("navigation_denied" | "not_your_tab")
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_ne!(
        gone["status"], "ok",
        "a page off http has no address to report: {gone}"
    );
    s.finish().await
}
