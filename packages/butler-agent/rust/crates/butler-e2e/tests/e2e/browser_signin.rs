//! P2b signed-in sites: per-conversation site grants fence every call before
//! native dispatch, a drag from the user's own tabs grants its site, frames
//! and identity pages follow their classes, revocation fences live tabs, and
//! a schedule run uses its creating conversation's live grants.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod fill;
mod host;
mod import;
mod tool;

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use host::{admin, attach, call, call_turn, snapshot, tab};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const SHOP: &str = "https://www.fixture-shop.test/account";

/// Answers every dispatched op with the account page and the frames it reports.
fn page_host(frames: Arc<Mutex<Value>>) -> host::Respond {
    Arc::new(move |frame: Value| {
        let frames = frames.lock().unwrap().clone();
        Box::pin(async move {
            json!({"status":"ok","tab":frame["tab"],"url":SHOP,"obs":"o1","text":"heading \"Account\" [e1]","frames":frames})
        })
    })
}

#[tokio::test]
async fn signed_in_tabs_follow_conversation_site_grants() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-SIGNED-IN")?.start().await?;
    let admin = admin(&s);
    let other =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Other"}))
            .await?;
    let other = other.data()["session"]["id"].as_str().unwrap().to_owned();
    let frames = Arc::new(Mutex::new(json!([{"id":"f0","url":SHOP,"class":"main"}])));
    let host = attach(&s, page_host(frames.clone())).await?;

    // The user's own signed-in tab is never the agent's.
    snapshot(&admin, json!([tab("t1", "mine", SHOP, "user")])).await?;
    let result = call(&admin, "general", "tab.observe", "t1", json!({})).await?;
    assert_eq!(result["reason"], "not_your_tab", "{result}");

    // Another conversation's signed-in tab on the same site asks first.
    snapshot(
        &admin,
        json!([
            tab("t1", "mine", SHOP, "user"),
            tab("t2", &format!("conversation:{other}"), SHOP, "agent")
        ]),
    )
    .await?;
    let result = call(&admin, &other, "tab.observe", "t2", json!({})).await?;
    assert_eq!(result["reason"], "signed_in_grant_required", "{result}");
    assert_eq!(result["site"], "fixture-shop.test");
    assert!(
        !host.ops().contains(&"tab.observe".to_owned()),
        "refused before dispatch"
    );

    // Dragging the user's tab into a conversation grants its site there only.
    snapshot(
        &admin,
        json!([
            tab("t1", "conversation:general", SHOP, "agent"),
            tab("t2", &format!("conversation:{other}"), SHOP, "agent")
        ]),
    )
    .await?;
    let result = call(&admin, "general", "tab.observe", "t1", json!({})).await?;
    assert_eq!(result["status"], "ok", "{result}");
    let sent = host.last("tab.observe").unwrap();
    assert_eq!(sent["args"]["policy"]["mode"], "signed_in");
    assert_eq!(
        sent["args"]["policy"]["sites"],
        json!(["fixture-shop.test"])
    );
    let result = call(&admin, &other, "tab.observe", "t2", json!({})).await?;
    assert_eq!(
        result["reason"], "signed_in_grant_required",
        "another conversation asks again: {result}"
    );

    // An approved card records the other conversation's grant.
    let granted = call(
        &admin,
        &other,
        "signin.grant",
        "",
        json!({"site":"fixture-shop.test"}),
    )
    .await?;
    assert_eq!(granted["status"], "ok", "{granted}");
    assert_eq!(
        call(&admin, &other, "tab.observe", "t2", json!({})).await?["status"],
        "ok"
    );

    hops_and_frames(&admin, &host, &frames).await?;
    schedule_inherits_creator_grants(&s, &admin, &other).await?;

    // Revoking the site fences every conversation and tells the host.
    snapshot(
        &admin,
        json!([
            tab("t1", "conversation:general", SHOP, "agent"),
            tab("t2", &format!("conversation:{other}"), SHOP, "agent")
        ]),
    )
    .await?;
    let revoked = admin
        .send(
            Method::POST,
            "/security/signins/site",
            Some(json!({"site":"fixture-shop.test","revoke":true})),
            &[],
        )
        .await?;
    assert_eq!(revoked.status, 200, "{}", revoked.text);
    for (session, id) in [("general", "t1"), (other.as_str(), "t2")] {
        let result = call(&admin, session, "tab.observe", id, json!({})).await?;
        assert_eq!(
            result["reason"], "signed_in_grant_required",
            "{session}: {result}"
        );
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let fence = host.last("use.signin_revoked").expect("live tabs fenced");
    assert_eq!(fence["args"]["site"], "fixture-shop.test");

    // The standing per-site allow (Settings only) covers every conversation.
    let standing = admin
        .send(
            Method::POST,
            "/security/signins/site",
            Some(json!({"site":"fixture-shop.test","all_conversations":true})),
            &[],
        )
        .await?;
    assert_eq!(standing.status, 200, "{}", standing.text);
    assert_eq!(
        call(&admin, &other, "tab.observe", "t2", json!({})).await?["status"],
        "ok"
    );
    let rows = admin
        .send(Method::GET, "/security/signins", None, &[])
        .await?;
    let row = rows.data()["sites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["site"] == "fixture-shop.test")
        .cloned()
        .unwrap();
    assert_eq!(row["all_conversations"], true, "{row}");
    s.finish().await
}

/// Ungranted hops are refused before dispatch; identity pages are read-only;
/// a frame main misclassifies closes the page.
async fn hops_and_frames(
    admin: &butler_e2e::e2e::security::AdminClient,
    host: &host::Host,
    frames: &Mutex<Value>,
) -> Result<(), HarnessError> {
    let evil = "https://pay.fixture-evil.test/collect";
    snapshot(
        admin,
        json!([tab("t1", "conversation:general", evil, "agent")]),
    )
    .await?;
    let result = call(admin, "general", "tab.observe", "t1", json!({})).await?;
    assert_eq!(result["reason"], "signed_in_grant_required", "{result}");
    assert_eq!(result["site"], "fixture-evil.test");
    let act = call(
        admin,
        "general",
        "tab.act",
        "t1",
        json!({"steps":[{"action":"click","ref":"e1"}]}),
    )
    .await?;
    assert_eq!(act["steps"][0]["status"], "not_dispatched", "{act}");

    let idp = "https://accounts.google.com/o/oauth2/auth";
    snapshot(
        admin,
        json!([tab("t1", "conversation:general", idp, "agent")]),
    )
    .await?;
    let observe = call(admin, "general", "tab.observe", "t1", json!({})).await?;
    assert_ne!(
        observe["reason"], "signed_in_grant_required",
        "identity pages are readable: {observe}"
    );
    let act = call(
        admin,
        "general",
        "tab.prepare",
        "t1",
        json!({"steps":[{"action":"click","ref":"e1"}]}),
    )
    .await?;
    assert_eq!(
        act["reason"], "signed_in_grant_required",
        "acting on an identity page asks: {act}"
    );
    assert_eq!(act["site"], "google.com");

    // Unknown cross-site frames may load but must be reported closed; a
    // misclassified frame fails Rust's re-check and the page is closed.
    snapshot(
        admin,
        json!([tab("t1", "conversation:general", SHOP, "agent")]),
    )
    .await?;
    let ads = "https://ads.fixture-ads.test/slot";
    *frames.lock().unwrap() = json!([{"id":"f0","url":SHOP,"class":"main"},{"id":"f1","url":ads,"class":"unknown"},
        {"id":"f2","url":"https://postcode.map.daum.net/search","class":"utility"},{"id":"f3","url":"https://js.tosspayments.com/w","class":"payment"}]);
    assert_eq!(
        call(admin, "general", "tab.observe", "t1", json!({})).await?["status"],
        "ok"
    );
    *frames.lock().unwrap() =
        json!([{"id":"f0","url":SHOP,"class":"main"},{"id":"f1","url":ads,"class":"granted"}]);
    let result = call(admin, "general", "tab.observe", "t1", json!({})).await?;
    assert_eq!(result["reason"], "navigation_denied", "{result}");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        host.last("use.revoked").is_some(),
        "the misreported page is closed"
    );
    *frames.lock().unwrap() = json!([{"id":"f0","url":SHOP,"class":"main"}]);
    Ok(())
}

async fn schedule_inherits_creator_grants(
    s: &butler_e2e::e2e::scenario::Scenario,
    admin: &butler_e2e::e2e::security::AdminClient,
    other: &str,
) -> Result<(), HarnessError> {
    let third =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Target"}))
            .await?;
    let third = third.data()["session"]["id"].as_str().unwrap().to_owned();
    let created = s
        .gw
        .post("/automations", json!({"title":"Check orders","prompt_body":"Check orders","target_session_id":third,"interval_seconds":3600,"source_session_id":"general"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let run =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn = run.data()["run"]["turn_id"].as_str().unwrap().to_owned();
    snapshot(
        admin,
        json!([
            tab("t1", "conversation:general", SHOP, "agent"),
            tab("t3", &format!("conversation:{third}"), SHOP, "agent")
        ]),
    )
    .await?;
    let result = call_turn(admin, &third, "tab.observe", "t3", json!({}), Some(&turn)).await?;
    assert_eq!(
        result["status"], "ok",
        "the schedule run uses its creator's grant: {result}"
    );
    let result = call(admin, &third, "tab.observe", "t3", json!({})).await?;
    assert_eq!(
        result["reason"], "signed_in_grant_required",
        "a normal turn there asks: {result}"
    );
    let _ = other;
    Ok(())
}

/// The module stays off with only the owner-only file store; no route stores a password.
#[tokio::test]
async fn signin_module_is_off_with_the_file_store() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-SIGNIN-OFF")?.start().await?;
    let admin = admin(&s);
    let listed = admin
        .send(Method::GET, "/security/signins", None, &[])
        .await?;
    assert_eq!(listed.status, 200, "{}", listed.text);
    assert_eq!(listed.data()["available"], false);
    let added = admin
        .send(
            Method::POST,
            "/security/signins",
            Some(
                json!({"site":"fixture-shop.test","username":"owner","password":"canary-off-7f3"}),
            ),
            &[],
        )
        .await?;
    assert_eq!(added.status, 409, "{}", added.text);
    assert_eq!(added.body["error"]["code"], "signin_unavailable");
    assert!(!added.text.contains("canary-off-7f3"));
    let remote = s.gw.get("/security/signins").await?;
    assert_eq!(remote.status, 403, "host only: {}", remote.text);
    snapshot(
        &admin,
        json!([tab("t1", "conversation:general", SHOP, "agent")]),
    )
    .await?;
    call(
        &admin,
        "general",
        "signin.grant",
        "",
        json!({"site":"fixture-shop.test"}),
    )
    .await?;
    let looked = call(&admin, "general", "signin.lookup", "t1", json!({})).await?;
    assert_eq!(looked["reason"], "signin_unavailable", "{looked}");
    s.finish().await
}

fn canary_absent(root: &std::path::Path, canary: &str, logs: &str) {
    assert!(!logs.contains(canary), "canary in agent logs");
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = std::fs::read(&path) {
                assert!(
                    !bytes
                        .windows(canary.len())
                        .any(|window| window == canary.as_bytes()),
                    "canary in {}",
                    path.display()
                );
            }
        }
    }
}
