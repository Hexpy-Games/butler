//! Real gateway ownership fences, before anything reaches the Electron host.
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;

#[tokio::test]
async fn browser_ownership_and_control_fence_before_dispatch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-OWNERSHIP")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let denied =
        s.gw.post("/internal/browser-host/events", json!({"tabs":[]}))
            .await?;
    assert_eq!(denied.status, 403);
    let event = json!({"tabs":[
        {"id":"mine","owner":"mine","profile":"signed_in","epoch":1,"holder":"user"},
        {"id":"other","owner":"conversation:other","profile":"signed_out","epoch":1,"holder":"agent"},
        {"id":"owned","owner":"conversation:general","profile":"signed_out","epoch":2,"holder":"user"},
        {"id":"private","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":"http://127.0.0.1/"}
    ]});
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(event),
                &[]
            )
            .await?
            .status,
        200
    );
    for (tab, reason) in [
        ("mine", "not_your_tab"),
        ("other", "not_your_tab"),
        ("owned", "user_control"),
        ("private", "navigation_denied"),
    ] {
        let response = admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({"op":"tab.observe","session":"general","tab":tab,"args":{}})),
                &[],
            )
            .await?;
        assert_eq!(response.status, 200, "{}", response.text);
        assert!(response.text.contains(reason), "{}", response.text);
        let response = admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({
                    "op":"tab.act","session":"general","tab":tab,
                    "args":{"steps":[{"action":"click","ref":"e1"},{"action":"click","ref":"e2"}]}
                })),
                &[],
            )
            .await?;
        assert_eq!(response.status, 200, "{}", response.text);
        let result: serde_json::Value = serde_json::from_str(&response.text).unwrap();
        let steps = result["steps"].as_array().expect("one receipt per step");
        assert_eq!(steps.len(), 2);
        if tab != "private" {
            let close = admin
                .send(
                    Method::POST,
                    "/internal/browser/calls",
                    Some(json!({
                        "op":"tab.close","session":"general","tab":tab,"args":{}
                    })),
                    &[],
                )
                .await?;
            assert_eq!(close.status, 200);
            assert!(close.text.contains(reason), "{}", close.text);
        }
        for step in steps {
            assert_eq!(step["status"], "not_dispatched");
            assert_eq!(step["reason"], reason);
        }
    }
    for url in [
        "file:///etc/passwd",
        "http://127.0.0.1/",
        "http://169.254.169.254/",
        "http://10.0.0.1/", // privacy-hygiene: allow-private-ip (denied LAN fixture)
    ] {
        let response = admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({"op":"tab.open","session":"general","args":{"url":url}})),
                &[],
            )
            .await?;
        assert_eq!(response.status, 400, "{url}: {}", response.text);
    }
    s.finish().await
}

#[tokio::test]
async fn moved_browser_tab_fences_previous_owner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-MOVE")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    for owner in ["general", "destination"] {
        let snapshot = json!({"tabs":[{"id":"moved", "owner":format!("conversation:{owner}"),
            "profile":"signed_out", "epoch":2, "holder":"agent", "url":"https://example.com/"}]});
        assert_eq!(
            admin
                .send(
                    Method::POST,
                    "/internal/browser-host/events",
                    Some(snapshot),
                    &[]
                )
                .await?
                .status,
            200
        );
    }
    for op in [
        "tab.observe",
        "tab.prepare",
        "tab.act",
        "tab.wait",
        "tab.waiting",
        "tab.close",
    ] {
        let result = admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({
                    "op":op, "session":"general", "tab":"moved",
                    "args":{"steps":[{"action":"click","ref":"e1"}]}
                })),
                &[],
            )
            .await?;
        assert_eq!(result.status, 200);
        assert!(
            result.text.contains("not_your_tab"),
            "{op}: {}",
            result.text
        );
    }
    let result = admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(json!({
                "op":"tab.observe", "session":"destination", "tab":"moved", "args":{}
            })),
            &[],
        )
        .await?;
    assert!(
        result.text.contains("no_browser"),
        "new owner passed ownership fence: {}",
        result.text
    );
    s.finish().await
}

#[tokio::test]
async fn browser_move_reports_owner_changed_for_pending_observation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-MOVE-INFLIGHT")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    for owner in ["general", "destination"] {
        let snapshot = json!({"tabs":[{"id":"moved", "owner":format!("conversation:{owner}"),
            "profile":"signed_out", "epoch":2, "holder":"agent", "url":"https://example.com/"}]});
        assert_eq!(
            admin
                .send(
                    Method::POST,
                    "/internal/browser-host/events",
                    Some(snapshot),
                    &[]
                )
                .await?
                .status,
            200
        );
        if owner == "general" {
            let caller = AdminClient::new(s.gw.clone(), admin.admin.clone());
            let pending = tokio::spawn(async move {
                caller
                    .send(
                        Method::POST,
                        "/internal/browser/calls",
                        Some(json!({
                            "op":"tab.observe","session":"general","tab":"moved","args":{}
                        })),
                        &[],
                    )
                    .await
            });
            let mut buffer = String::new();
            let _ = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
            let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
            let moved = json!({"tabs":[{"id":"moved","owner":"conversation:destination",
                "profile":"signed_out","epoch":3,"holder":"agent","url":"https://example.com/"}]});
            admin
                .send(
                    Method::POST,
                    "/internal/browser-host/events",
                    Some(moved),
                    &[],
                )
                .await?;
            admin
                .send(
                    Method::POST,
                    &format!(
                        "/internal/browser-host/results/{}",
                        frame["id"].as_str().unwrap()
                    ),
                    Some(json!({"status":"ok","tab":"moved","text":"new owner's private page"})),
                    &[],
                )
                .await?;
            let result = pending.await.unwrap()?;
            assert!(result.text.contains("owner_changed"), "{}", result.text);
            assert!(!result.text.contains("private page"));
        }
    }
    drop(stream);
    s.finish().await
}
