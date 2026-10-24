//! Observation expiry must not poison refusal memory for an unchanged page.
use super::support::{admin, call, center, node, open, publish, selected, setup};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn reobserved_resend_recovers_from_stale_ref() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-STALE-REF")?.start().await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = &opened["tab"];
    let observe = json!({"include_image":true,"settle":true});
    let first = call(&admin, "general", "tab.observe", tab, observe.clone()).await?;
    assert_eq!(first["status"], "ok", "{first}");
    let point = center(&first, node(&first, "button", "Confirm"));
    let steps = json!([{"action":"click","point":point,"expect":"button Confirm"}]);

    // Reload expires the observation without adding a progress history entry,
    // just as a document change during user control would. Wait for its epoch
    // and load completion without observing, so first.obs is still history's newest.
    let reload = json!([{"action":"reload"}]);
    let prepared = call(
        &admin,
        "general",
        "tab.prepare",
        tab,
        json!({"observation":first["obs"],"steps":reload}),
    )
    .await?;
    assert_eq!(prepared["status"], "ok", "{prepared}");
    let acted = call(
        &admin,
        "general",
        "tab.act",
        tab,
        json!({"observation":first["obs"],"steps":reload,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["completed"], 1, "{acted}");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
            let current = listed["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == *tab)
                .unwrap();
            if current["epoch"].as_u64().unwrap() > first["epoch"].as_u64().unwrap()
                && current["status"] == "idle"
            {
                return Ok::<(), HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("reload completes")?;
    let stale = call(
        &admin,
        "general",
        "tab.prepare",
        tab,
        json!({"observation":first["obs"],"steps":steps}),
    )
    .await?;
    assert_eq!(stale["status"], "refused", "{stale}");
    assert_eq!(stale["reason"], "stale_ref", "{stale}");

    let fresh = call(&admin, "general", "tab.observe", tab, observe.clone()).await?;
    assert_eq!(fresh["status"], "ok", "{fresh}");
    assert_ne!(fresh["obs"], first["obs"]);
    assert_eq!(fingerprint(&fresh), fingerprint(&first));
    let prepared = call(
        &admin,
        "general",
        "tab.prepare",
        tab,
        json!({"observation":fresh["obs"],"steps":steps}),
    )
    .await?;
    assert_eq!(prepared["status"], "ok", "{prepared}");
    let acted = call(
        &admin,
        "general",
        "tab.act",
        tab,
        json!({"observation":fresh["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["completed"], 1, "{acted}");
    let after = call(&admin, "general", "tab.observe", tab, observe.clone()).await?;
    assert!(super::text(&after).contains("Confirmed"), "{after}");

    // A page-state refusal still survives re-observation of the same state.
    let wrong = json!([{"action":"click","point":point,"expect":"button Submit"}]);
    let refused = call(
        &admin,
        "general",
        "tab.prepare",
        tab,
        json!({"observation":after["obs"],"steps":wrong}),
    )
    .await?;
    assert_eq!(refused["reason"], "point_mismatch", "{refused}");
    let again = call(&admin, "general", "tab.observe", tab, observe).await?;
    let repeated = call(
        &admin,
        "general",
        "tab.prepare",
        tab,
        json!({"observation":again["obs"],"steps":wrong}),
    )
    .await?;
    assert_eq!(repeated["reason"], "repeated_refusal", "{repeated}");
    assert_eq!(repeated["previous_reason"], "point_mismatch", "{repeated}");
    s.finish().await
}

// Compare all inputs to the page fingerprint, excluding observation-local refs.
fn fingerprint(observation: &Value) -> Value {
    let mut controls: Vec<Value> = observation["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["actionable"] == true)
        .map(|n| json!([n["role"], n["name"]]))
        .collect();
    controls.sort_by_key(Value::to_string);
    let fields: Vec<Value> = observation["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| json!([f["position"], f["name"], f["value"]]))
        .collect();
    json!([observation["url"], controls, fields])
}
