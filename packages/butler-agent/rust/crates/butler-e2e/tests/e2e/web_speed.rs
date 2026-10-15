//! Offline public-tool search profiling with a streamed Responses stub.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod fixture;

use butler_e2e::e2e::{HarnessError, config::ModelChoice, fixtures, scenario::Setup};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn web_search_profiles_planning_and_preserves_parallel_results_and_followups()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = fixture::Fixture::start().await?;
    let setup = Setup::new("WEB-SPEED")?
        .model(ModelChoice {
            model: "openai/gpt-6-astra".into(),
            effort: Some("xhigh".into()),
        })
        .env("BUTLER_CODEX_BASE_URL", &fixture.base)
        .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key");
    fixtures::stub_codex_auth(&setup.sandbox.codex_home())?;
    let s = setup.start().await?;
    let catalog = s.gw.get("/model-catalog").await?;
    let provider = catalog.data()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider_id"] == "openai")
        .unwrap();
    let preset = &provider["presets"]["planning"];
    let selected = butler_models::models::parse_model_ref(preset["model"].as_str().unwrap());
    *fixture.planning_preset.lock().unwrap() =
        json!({"model": selected.model_id, "effort": preset["effort"]});
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] = json!({"provider":"brave","readerBackend":"disabled","model":"openai/gpt-6-astra","braveApiBase":format!("{}/search",fixture.base)});
    std::fs::write(path, serde_json::to_vec(&config)?)?;
    let (_, turn) = s
        .turn("general", "Compare three subjects with complete sources")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let outputs = fixture.outputs.lock().unwrap().clone();
    if let Some(dir) = std::env::var_os("BUTLER_WEB_SPEED_EVIDENCE") {
        std::fs::write(
            std::path::Path::new(&dir).join("search-profile.json"),
            serde_json::to_vec_pretty(&outputs)?,
        )?;
    }
    let searches = outputs
        .iter()
        .filter(|o| o["query"].is_string())
        .collect::<Vec<_>>();
    assert_eq!(searches.len(), 4, "{outputs:?}");
    let first = searches[0];
    assert_eq!(first["search_plan"]["mode"], "smart");
    assert_eq!(first["results"].as_array().unwrap().len(), 10);
    for (i, result) in first["results"].as_array().unwrap().iter().enumerate() {
        let query = ["alpha", "beta", "gamma"][i % 3];
        assert_eq!(
            result["url"],
            format!("https://example.com/{query}/{}", i / 3)
        );
        assert_eq!(result["snippet"], fixture::snippet(query, i / 3).trim());
    }
    let planner = &first["timings"]["planner_calls"][0];
    assert_eq!(planner["model"], selected.model_id);
    assert_eq!(planner["reasoning_effort"], preset["effort"]);
    assert!(planner["prompt_bytes"].as_u64().unwrap() > 1000);
    assert!(planner["output_bytes"].as_u64().unwrap() > 100);
    assert!(planner["ttft_ms"].is_number());
    assert_eq!(fixture.planners.load(Ordering::SeqCst), 1);
    // The fallback wrapper retains DuckDuckGo's existing two-request cap.
    assert_eq!(fixture.parallel.load(Ordering::SeqCst), 2);
    for followup in &searches[1..] {
        assert_eq!(followup["search_plan"]["mode"], "direct");
        assert_eq!(followup["timings"]["planner_calls"], json!([]));
        assert_eq!(followup["results"].as_array().unwrap().len(), 5);
    }
    assert!(
        outputs
            .iter()
            .any(|o| o["warnings"] == json!(["page-reader-disabled"]))
    );
    s.finish().await
}

#[tokio::test]
async fn web_read_streaming_document_keeps_all_content() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = butler_e2e::e2e::sandbox::Sandbox::new("WEB-READ-STREAM")?;
    let probe = build_probe(&sandbox).await?;
    let result = sandbox.root.join("result.json");
    let output = std::fs::File::create(sandbox.logs.join("web-probe.log"))?;
    let mut child = tokio::process::Command::new(probe)
        .env("HOME", &sandbox.home)
        .env("BUTLER_DATA", &sandbox.data)
        .env("BUTLER_WEB_PROBE_RESULT", &result)
        .stdout(output.try_clone()?)
        .stderr(output)
        .kill_on_drop(true)
        .spawn()?;
    let status = child.wait().await?;
    assert!(
        status.success(),
        "{}",
        std::fs::read_to_string(sandbox.logs.join("web-probe.log"))?
    );
    let report: Value = serde_json::from_slice(&std::fs::read(&result)?)?;
    assert_eq!(report["planner"].as_array().unwrap().len(), 1);
    assert_eq!(report["search"]["results"].as_array().unwrap().len(), 10);
    for (i, item) in report["search"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let q = ["alpha", "beta", "gamma"][i % 3];
        assert_eq!(item["url"], format!("https://example.com/{q}/{}", i / 3));
        assert_eq!(
            item["snippet"],
            format!(
                "Full details {q}/{}: {}",
                i / 3,
                "Complete source content. ".repeat(60)
            )
            .trim()
        );
    }
    let page = &report["page"];
    assert_eq!(page["ok"], true);
    assert_eq!(page["render_recommended"], true);
    let markdown = page["markdown"].as_str().unwrap();
    for i in 0..12 {
        assert!(markdown.contains(&format!("Source paragraph {i}: all details retained.")));
    }
    assert_eq!(page["truncated"], false);
    assert!(report["read_ms"].as_u64().unwrap() < 5000);
    assert!(
        report["request_events"]["gamma"][0].as_u64().unwrap()
            < report["request_events"]["alpha"][1].as_u64().unwrap(),
        "refill a slot before slow query completes"
    );
    if let Some(dir) = std::env::var_os("BUTLER_WEB_SPEED_EVIDENCE") {
        std::fs::copy(
            result,
            std::path::Path::new(&dir).join("web-probe-after.json"),
        )?;
    }
    sandbox.mark_success();
    Ok(())
}

/// The prebuilt probe named by `BUTLER_E2E_WEB_PROBE_BIN` (CI ships it with
/// the test archive), else this workspace's build of the example.
async fn build_probe(
    sandbox: &butler_e2e::e2e::sandbox::Sandbox,
) -> Result<std::path::PathBuf, HarnessError> {
    if let Some(path) = std::env::var_os("BUTLER_E2E_WEB_PROBE_BIN") {
        let path = std::path::PathBuf::from(path);
        assert!(
            path.is_file(),
            "BUTLER_E2E_WEB_PROBE_BIN does not exist: {}",
            path.display()
        );
        return Ok(path);
    }
    let root = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| butler_e2e::e2e::binary::workspace_root().join("target"));
    let log = std::fs::File::create(sandbox.logs.join("probe-build.log"))?;
    let status = tokio::process::Command::new("cargo")
        .current_dir(butler_e2e::e2e::binary::workspace_root())
        .args([
            "build",
            "-p",
            "butler-runtime",
            "--features",
            "test-support",
            "--example",
            "web-access-smoke",
        ])
        .env("HOME", &sandbox.home)
        .env("BUTLER_DATA", &sandbox.data)
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .status()
        .await?;
    assert!(
        status.success(),
        "{}",
        std::fs::read_to_string(sandbox.logs.join("probe-build.log"))?
    );
    Ok(root.join("debug/examples/web-access-smoke"))
}
