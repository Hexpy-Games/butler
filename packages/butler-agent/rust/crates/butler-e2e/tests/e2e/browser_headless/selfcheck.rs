//! P1b self-check without the App: `output.check` runs on Butler's own
//! browser with the App checker's policy and report shape.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, publish_as, selected, setup};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

async fn check(
    admin: &butler_e2e::e2e::security::AdminClient,
    id: &str,
    image: bool,
) -> Result<Value, HarnessError> {
    // The first check may wait out the pinned browser's first-use install and
    // launch; a failed check is retried a few times, never hidden.
    let mut failures = 0;
    for _ in 0..450 {
        let reply = admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({"output_id":id,"session_id":"general","include_image":image})),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        if reply.body["reason"] == "check_failed" && failures < 3 {
            failures += 1;
        } else if reply.body["reason"] != "browser_installing" {
            return Ok(reply.body);
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    panic!("the output check never ran");
}

#[tokio::test]
async fn output_check_runs_on_the_headless_browser_without_the_app() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-SELFCHECK")?.start().await?;
    let admin = admin(&s);
    let (broken, _) = publish_as(&s, "Publish broken").await?;
    let report = check(&admin, &broken, true).await?;
    assert_eq!(report["status"], "issues", "{report}");
    assert!(report["errors"]["total"].as_u64().unwrap() >= 1, "{report}");
    assert!(
        report["errors"]["shown"]
            .to_string()
            .contains("fixture failed to start"),
        "{report}"
    );
    assert!(
        report["layout"]["overflow_px"]["mobile"].as_u64().unwrap() > 0,
        "{report}"
    );
    assert_eq!(report["layout"]["blank"], false, "{report}");
    assert_eq!(
        report["warnings"],
        json!(["root_absolute_paths"]),
        "{report}"
    );
    assert_eq!(report["image"]["mime_type"], "image/jpeg", "{report}");
    let (clean, _) = publish_as(&s, "Publish fixture").await?;
    let report = check(&admin, &clean, false).await?;
    assert_eq!(report["status"], "ok", "{report}");
    assert!(report.get("image").is_none(), "{report}");
    s.finish().await
}
