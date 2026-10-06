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
