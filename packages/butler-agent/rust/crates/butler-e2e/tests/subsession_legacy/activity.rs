//! The same public worker rows must survive pagination and session filtering.
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::Value;

pub(super) async fn assert_pages(
    s: &Scenario,
    chat: &str,
    full: &Value,
) -> Result<(), HarnessError> {
    let expected = full["workers"].as_array().unwrap();
    let mut cursor = String::new();
    let mut observed = Vec::new();
    for offset in 0..expected.len() {
        let reply =
            s.gw.get(&format!(
                "/worker-activity?include_history=true&limit=1{cursor}"
            ))
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let page = reply.data();
        assert_eq!(page["pagination"]["offset"], offset);
        assert_eq!(page["workers"].as_array().unwrap().len(), 1);
        observed.push(page["workers"][0].clone());
        if offset + 1 < expected.len() {
            assert_eq!(page["pagination"]["has_more"], true);
            cursor = format!(
                "&cursor={}",
                page["pagination"]["next_cursor"].as_str().unwrap()
            );
        } else {
            assert_eq!(page["pagination"]["has_more"], false);
        }
    }
    assert_eq!(&observed, expected);
    let filtered =
        s.gw.get(&format!(
            "/worker-activity?include_history=true&session_id={chat}"
        ))
        .await?;
    assert_eq!(filtered.status, 200, "{}", filtered.text);
    assert_eq!(filtered.data(), full);
    let offset =
        s.gw.get("/worker-activity?include_history=true&limit=1&offset=2")
            .await?;
    assert_eq!(offset.status, 200, "{}", offset.text);
    assert_eq!(offset.data()["workers"][0], expected[2]);
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let missing = URL_SAFE_NO_PAD.encode(br#"{"v":1,"worker_id":"missing-worker"}"#);
    let fallback =
        s.gw.get(&format!(
            "/worker-activity?include_history=true&limit=1&offset=2&cursor={missing}"
        ))
        .await?;
    assert_eq!(fallback.status, 200, "{}", fallback.text);
    assert_eq!(fallback.data(), offset.data());
    let active = s.gw.get("/worker-activity").await?;
    assert_eq!(active.status, 200, "{}", active.text);
    for worker in active.data()["workers"].as_array().unwrap() {
        assert_eq!(worker["terminal"], false);
    }
    Ok(())
}
