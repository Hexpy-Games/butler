//! Native capability frames and document PDF export, using the stub provider only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::shell_app::driver::{SERIAL, SHOTS, Shell};
use butler_e2e::e2e::{HarnessError, config::nonempty};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn cef_web_output_renders_in_the_viewer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        nonempty(SHOTS).is_some() && nonempty("BUTLER_CEF_DIR").is_some(),
        "CEF shell required"
    );
    let _serial = SERIAL.lock().await;
    let setup = butler_e2e::e2e::scenario::Setup::new("cef_web_output_renders_in_the_viewer")?
        .data_folder_token()
        .stub_cassette(super::browser_outputs::stub::cassette()?);
    let outputs = setup.sandbox.data.join("outputs");
    std::fs::create_dir_all(&outputs)?;
    drop(butler_platform::sqlite::open(outputs.join("index.sqlite"))?);
    let scenario = setup.start().await?;
    scenario.turn("general", "Publish").await?;
    let mut onboarding = scenario.gw.settings().await?["onboarding"].clone();
    onboarding["consent_version"] = json!(2);
    onboarding["accepted_at"] = json!("2026-01-01T00:00:00Z");
    onboarding["completed_at"] = json!("2026-01-01T00:00:00Z");
    assert_eq!(
        scenario
            .gw
            .patch("/settings", json!({"onboarding":onboarding}))
            .await?
            .status,
        200
    );
    let mut shell = Shell::start(
        &scenario.sandbox,
        &[(
            "BUTLER_APP_SERVER_PORT",
            scenario.agent.launch.port.to_string(),
        )],
    )
    .await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = &scenario.gw;
    let session = "general";
    let artifacts = gw.get(&format!("/artifacts?session_id={session}")).await?;
    assert_eq!(artifacts.status, 200, "{}", artifacts.text);
    let data = artifacts.data();
    let items = data
        .as_array()
        .or_else(|| data["artifacts"].as_array())
        .unwrap();
    let artifact = items
        .iter()
        .find(|a| a["kind"] == "web")
        .expect("web artifact");
    shell
        .run(&[
            &format!("artifact-open {artifact}"),
            "wait-anchor output-reload",
            "embed-frame",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let frame = loop {
        shell.run(&["embed-frame"]).await?;
        let frame = shell.report("embed-frame")?;
        if frame["embeds"][0]["pixel"].is_array() || tokio::time::Instant::now() >= deadline {
            break frame;
        }
        shell.run(&["wait 50"]).await?;
    };
    assert_eq!(frame["embeds"].as_array().unwrap().len(), 1);
    assert!(frame["embeds"][0]["size"][0].as_u64().unwrap() > 1);
    assert!(
        frame["embeds"][0]["pixel"].is_array(),
        "real CEF frame readback"
    );
    assert!(
        shell.browser_state().await?["tabs"]
            .as_array()
            .unwrap()
            .is_empty(),
        "embeds are not tabs"
    );
    shell
        .run(&[
            "click output-reload",
            "wait-anchor output-browser",
            "embed-frame",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let reloaded = loop {
        shell.run(&["embed-frame"]).await?;
        let next = shell.report("embed-frame")?;
        if next["embeds"][0]["id"] != frame["embeds"][0]["id"]
            || tokio::time::Instant::now() >= deadline
        {
            break next;
        }
        shell.run(&["wait 50"]).await?;
    };
    assert_ne!(
        reloaded["embeds"][0]["id"], frame["embeds"][0]["id"],
        "reload waits for a freshly resolved view before opening a new embed"
    );
    let view = gw
        .get(&format!(
            "/outputs/{}/view",
            artifact["id"].as_str().unwrap()
        ))
        .await?;
    shell.run(&["click output-browser"]).await?;
    let browser = shell.browser_state().await?;
    assert_eq!(
        browser["tabs"][0]["owner"],
        format!("conversation:{session}")
    );
    let actual = reqwest::Url::parse(browser["tabs"][0]["url"].as_str().unwrap()).unwrap();
    let expected = reqwest::Url::parse(view.data()["url"].as_str().unwrap()).unwrap();
    assert_eq!(actual.origin(), expected.origin());
    assert!(
        reqwest::get(actual)
            .await?
            .text()
            .await?
            .contains("<h1>Output</h1>")
    );
    shell.finish().await?;
    scenario.finish().await
}

#[tokio::test]
async fn document_exports_pdf() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        nonempty(SHOTS).is_some() && nonempty("BUTLER_CEF_DIR").is_some(),
        "CEF shell required"
    );
    let _serial = SERIAL.lock().await;
    let scenario = butler_e2e::e2e::scenario::Setup::new("document_exports_pdf")?
        .data_folder_token()
        .stub_cassette(super::browser_outputs::stub::cassette()?)
        .start()
        .await?;
    let mut onboarding = scenario.gw.settings().await?["onboarding"].clone();
    onboarding["consent_version"] = json!(2);
    onboarding["accepted_at"] = json!("2026-01-01T00:00:00Z");
    onboarding["completed_at"] = json!("2026-01-01T00:00:00Z");
    assert_eq!(
        scenario
            .gw
            .patch("/settings", json!({"onboarding":onboarding}))
            .await?
            .status,
        200
    );
    let mut shell = Shell::start(
        &scenario.sandbox,
        &[(
            "BUTLER_APP_SERVER_PORT",
            scenario.agent.launch.port.to_string(),
        )],
    )
    .await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let path = scenario.sandbox.root.join("document.pdf");
    let doc = json!({"title":"Exported document", "body":"# PDF export\n\nComplete document body.", "rev":1, "assets":[]});
    shell
        .run(&[&format!("document-export {} {doc}", path.display())])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !path.exists() && tokio::time::Instant::now() < deadline {
        shell.run(&["wait 50"]).await?;
    }
    let pdf = std::fs::read(&path)?;
    assert!(pdf.starts_with(b"%PDF"));
    let pages = regex::Regex::new(r"/Type\s*/Page(?:\s|/|>)")
        .unwrap()
        .find_iter(&String::from_utf8_lossy(&pdf))
        .count();
    assert!(pages >= 1, "at least one page");
    println!("PDF export: {} bytes, {pages} pages", pdf.len());
    shell.run(&["embed-frame"]).await?;
    assert!(
        shell.report("embed-frame")?["embeds"]
            .as_array()
            .unwrap()
            .is_empty(),
        "hidden embeds close"
    );
    shell.finish().await?;
    scenario.finish().await
}
