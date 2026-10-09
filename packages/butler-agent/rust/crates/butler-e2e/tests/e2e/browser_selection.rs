//! S5 public gateway ownership and scrap storage, stub only.
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;
#[tokio::test]
async fn selection_is_readable_under_user_control_but_not_from_another_owner()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-SELECTION")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    admin.send(Method::POST, "/internal/browser-host/events", Some(json!({"tabs":[
        {"id":"owned","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"user"},
        {"id":"other","owner":"conversation:other","profile":"signed_out","epoch":1,"holder":"agent"}
    ]})), &[]).await?;
    for (tab, reason) in [("owned", "no_browser"), ("other", "not_your_tab")] {
        let response = admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({"op":"tab.selection","session":"general","tab":tab,"args":{}})),
                &[],
            )
            .await?;
        assert_eq!(response.status, 200, "{}", response.text);
        assert!(response.text.contains(reason), "{}", response.text);
    }
    let item = json!({"id":"scrap-1","kind":"scrap","title":"선택한 청자","url":"https://example.com/","text":"청자 상품","crop":"data:image/jpeg;base64,YQ==","capturedAt":"2026-10-09T00:00:00Z"});
    let saved = s.gw.post("/library", item.clone()).await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    let page = s.gw.get("/library?kind=scrap").await?;
    assert_eq!(page.status, 200, "{}", page.text);
    assert!(page.text.contains("선택한 청자"));
    assert!(page.text.contains("capturedAt"));
    s.finish().await
}
