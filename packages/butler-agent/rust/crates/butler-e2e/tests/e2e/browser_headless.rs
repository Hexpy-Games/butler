//! P4 headless backend: Butler's own browser serves the same browser tools
//! when no App is attached. Runs with `BUTLER_E2E_BROWSER_BACKEND=headless`
//! (a real browser; offline fixtures on the output origin, stub models only).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod backend;
mod guard;
mod support;

use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::time::Duration;
use support::{admin, call, center, node, open, publish, selected, setup, tool_output};

fn text(value: &Value) -> String {
    value["text"].as_str().map_or_else(
        || {
            value["untrusted_content"]["text"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        },
        str::to_owned,
    )
}

#[tokio::test]
async fn headless_browser_serves_the_model_tools() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-TOOLS")?.start().await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    // The first use installs the pinned browser; the model's turn then opens at once.
    let warm = open(&admin, "warmup", &url).await?;
    assert_eq!(warm["status"], "ok", "{warm}");
    call(&admin, "warmup", "tab.close", &warm["tab"], json!({})).await?;
    let provider = s.provider()?;
    provider.add_placeholder("OUTPUT_URL", &url);
    s.turn("general", "Open fixture").await?;
    let opened = tool_output(provider.requests().last().unwrap());
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = opened["tab"].as_str().unwrap().to_owned();
    provider.add_placeholder("TAB", &tab);
    s.turn("general", "Observe fixture").await?;
    let observed = tool_output(provider.requests().last().unwrap());
    assert_eq!(
        observed["schema"], "butler.browser-observation.v1",
        "{observed}"
    );
    let page = text(&observed);
    let reference = page
        .split("button \"Confirm\" [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap_or_else(|| panic!("Confirm ref in {page}"))
        .to_owned();
    provider.add_placeholder("OBS", observed["obs"].as_str().unwrap());
    provider.add_placeholder("REF", &reference);
    s.turn("general", "Act fixture").await?;
    let acted = tool_output(provider.requests().last().unwrap());
    assert_eq!(
        acted["action"]["schema"], "butler.browser-action.v1",
        "{acted}"
    );
    assert_eq!(acted["action"]["completed"], 1, "{acted}");
    assert!(text(&acted).contains("Confirmed"), "{acted}");
    s.finish().await
}

#[tokio::test]
async fn headless_browser_answers_the_app_protocol() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-PROTOCOL")?.start().await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let me = "general";
    let opened = open(&admin, me, &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    assert_eq!(opened["profile"], "signed_out");
    let tab = opened["tab"].clone();
    let listed = call(&admin, me, "tabs.list", &Value::Null, json!({})).await?;
    assert_eq!(listed["tabs"][0]["id"], tab, "{listed}");

    // Layer 1 + 2: refs, fields and the marked 1024 px screenshot.
    let first = call(
        &admin,
        me,
        "tab.observe",
        &tab,
        json!({"include_image":true}),
    )
    .await?;
    assert_eq!(first["status"], "ok", "{first}");
    assert_eq!(first["image"]["mime_type"], "image/jpeg");
    assert_eq!(
        first["image_geometry"],
        json!({"width":1024,"height":640,"cssWidth":1280,"cssHeight":800})
    );
    assert!(
        text(&first).contains("button \"Confirm\""),
        "{}",
        text(&first)
    );

    // A ref click: prepared, approved, dispatched as trusted input, with a still.
    let confirm = node(&first, "button", "Confirm")["ref"].clone();
    let steps = json!([{"action":"click","ref":confirm}]);
    let prepared = call(
        &admin,
        me,
        "tab.prepare",
        &tab,
        json!({"observation":first["obs"],"steps":steps}),
    )
    .await?;
    assert_eq!(prepared["status"], "ok", "{prepared}");
    let acted = call(
        &admin,
        me,
        "tab.act",
        &tab,
        json!({"observation":first["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    assert!(
        acted["still_file"].is_object(),
        "a desktop still is stored: {acted}"
    );

    // A batch: click a field, type at the focus, click submit.
    let second = call(
        &admin,
        me,
        "tab.observe",
        &tab,
        json!({"include_image":true,"settle":true}),
    )
    .await?;
    assert!(text(&second).contains("Confirmed"), "{}", text(&second));
    let field = node(&second, "textbox", "Search")["ref"].clone();
    let submit = node(&second, "button", "Submit")["ref"].clone();
    let batch = json!([{"action":"click","ref":field},{"action":"type","value":"hello"},{"action":"click","ref":submit}]);
    let prepared = call(
        &admin,
        me,
        "tab.prepare",
        &tab,
        json!({"observation":second["obs"],"steps":batch}),
    )
    .await?;
    assert_eq!(prepared["steps"][1]["deferred"], true, "{prepared}");
    let acted = call(
        &admin,
        me,
        "tab.act",
        &tab,
        json!({"observation":second["obs"],"steps":batch,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["completed"], 3, "{acted}");

    // Point steps resolve by hit test before dispatch; a mismatch names the real hit.
    let third = call(
        &admin,
        me,
        "tab.observe",
        &tab,
        json!({"include_image":true,"settle":true}),
    )
    .await?;
    assert!(text(&third).contains("Typed hello"), "{}", text(&third));
    let point = center(&third, node(&third, "button", "Submit"));
    let wrong = call(&admin, me, "tab.prepare", &tab, json!({"observation":third["obs"],"steps":[{"action":"click","point":point,"expect":"button Ask"}]})).await?;
    assert_eq!(wrong["reason"], "point_mismatch", "{wrong}");
    assert_eq!(wrong["hit"]["name"], "Submit", "{wrong}");
    let steps = json!([{"action":"click","point":point,"expect":"button Submit"}]);
    let prepared = call(
        &admin,
        me,
        "tab.prepare",
        &tab,
        json!({"observation":third["obs"],"steps":steps}),
    )
    .await?;
    assert_eq!(
        prepared["steps"][0]["verification"], "verified",
        "{prepared}"
    );
    let acted = call(
        &admin,
        me,
        "tab.act",
        &tab,
        json!({"observation":third["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");

    // Screenshot (an artifact for the user), zoom (a close-up) and selection.
    let fourth = call(
        &admin,
        me,
        "tab.observe",
        &tab,
        json!({"include_image":true,"settle":true}),
    )
    .await?;
    let shot = call(
        &admin,
        me,
        "tab.screenshot",
        &tab,
        json!({"observation":fourth["obs"]}),
    )
    .await?;
    assert_eq!(shot["status"], "ok", "{}", shot["reason"]);
    let zoom = call(
        &admin,
        me,
        "tab.zoom",
        &tab,
        json!({"observation":fourth["obs"],"region":[0,0,256,160]}),
    )
    .await?;
    assert_eq!(zoom["status"], "ok", "{}", zoom["reason"]);
    assert!(
        zoom["mapping"]
            .as_str()
            .unwrap()
            .contains(fourth["obs"].as_str().unwrap())
    );
    let selection = call(&admin, me, "tab.selection", &tab, json!({})).await?;
    assert_eq!(
        selection["untrusted_content"]["elements"],
        json!([]),
        "{selection}"
    );

    dialogs_and_popups(&admin, &tab, &fourth).await?;
    guard::guard_denials(&admin, &s, &tab, &url).await?;
    guard::idle_reap(&s).await?;
    s.finish().await
}

async fn dialogs_and_popups(
    admin: &butler_e2e::e2e::security::AdminClient,
    tab: &Value,
    observation: &Value,
) -> Result<(), HarnessError> {
    let me = "general";
    let ask = node(observation, "button", "Ask")["ref"].clone();
    let steps = json!([{"action":"click","ref":ask}]);
    let prepared = call(
        admin,
        me,
        "tab.prepare",
        tab,
        json!({"observation":observation["obs"],"steps":steps}),
    )
    .await?;
    let pending = call(
        admin,
        me,
        "tab.act",
        tab,
        json!({"observation":observation["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(pending["status"], "dialog_pending", "{pending}");
    assert_eq!(pending["dialog"]["type"], "confirm", "{pending}");
    let blocked = call(admin, me, "tab.observe", tab, json!({})).await?;
    assert_eq!(
        blocked["status"], "dialog_pending",
        "a hidden dialog fences every call: {blocked}"
    );
    let answered = call(
        admin,
        me,
        "tab.dialog",
        tab,
        json!({"dialog":pending["dialog"]["id"],"accept":true}),
    )
    .await?;
    assert_eq!(answered["status"], "ok", "{answered}");
    assert_eq!(answered["steps"][0]["status"], "completed", "{answered}");
    let after = call(
        admin,
        me,
        "tab.observe",
        tab,
        json!({"include_image":true,"settle":true}),
    )
    .await?;
    assert!(text(&after).contains("Accepted"), "{}", text(&after));
    let events = answered["events"].as_array().cloned().unwrap_or_default();
    for kind in ["dialog_opened", "dialog_accepted"] {
        assert!(
            events.iter().any(|e| e["type"] == kind),
            "{kind}: {answered}"
        );
    }

    let popup = node(&after, "button", "Open popup")["ref"].clone();
    let steps = json!([{"action":"click","ref":popup}]);
    let prepared = call(
        admin,
        me,
        "tab.prepare",
        tab,
        json!({"observation":after["obs"],"steps":steps}),
    )
    .await?;
    let acted = call(
        admin,
        me,
        "tab.act",
        tab,
        json!({"observation":after["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    let mut opened = None;
    let mut events = acted["events"].as_array().cloned().unwrap_or_default();
    for _ in 0..50 {
        let listed = call(admin, me, "tabs.list", &Value::Null, json!({})).await?;
        events.extend(listed["events"].as_array().cloned().unwrap_or_default());
        if let Some(event) = events.iter().find(|e| e["type"] == "popup_opened") {
            opened = Some(event["popup"].clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let popup = opened.expect("popup_opened event");
    let listed = call(admin, me, "tabs.list", &Value::Null, json!({})).await?;
    let child = listed["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == popup)
        .cloned()
        .unwrap();
    assert_eq!(child["opener"], *tab, "{listed}");
    let seen = call(admin, me, "tab.observe", &popup, json!({"settle":true})).await?;
    assert!(text(&seen).contains("Popup page"), "{seen}");
    let closed = call(admin, me, "tab.close", &popup, json!({})).await?;
    assert_eq!(closed["status"], "ok", "{closed}");
    Ok(())
}
