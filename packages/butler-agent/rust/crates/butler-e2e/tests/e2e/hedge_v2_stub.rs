//! Stub-tier verification of eval v2, without provider credentials.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod model;
mod regexes;
mod v3;
use crate::live::hedge_v2 as v2;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) async fn run(mode: &str, case: &str) -> Result<(Value, Vec<Value>), HarnessError> {
    let model = model::Model::start(mode).await?;
    let search = v2::web::Search::start().await?;
    search.activate(case);
    let setup = Setup::new(&format!("HEDGE-V2-STUB-{mode}"))?
        .access(v2::EVAL_ACCESS)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{}/v1", model.base))
        .env("BUTLER_BROWSER_HEADLESS", "off")
        .env("BUTLER_WEB_READER_BACKEND", "disabled")
        .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key");
    let s = setup.start().await?;
    v2::configure(&s, &search.base).await?;
    let language = {
        let case = v2::cases::CASES.iter().find(|c| c.id == case).unwrap();
        v2::response_language(&s, case).await?
    };
    let browser = mode != "M1" && !mode.starts_with("delegated") && !mode.starts_with('U');
    let (log, server) = if browser {
        let host = v2::host::Host::attach(v2::preflight::admin(&s)).await?;
        (host.log.clone(), Some(tokio::spawn(host.serve())))
    } else {
        (Arc::new(Mutex::new(v2::host::Log::default())), None)
    };
    let case = v2::cases::CASES.iter().find(|c| c.id == case).unwrap();
    let result = v2::collect::run(&s, case, log).await;
    if let Some(server) = server {
        server.abort();
    }
    let mut record = result?;
    record["response_language"] = json!(language);
    assert_eq!(record["response_language"], record["lang"], "{record}");
    let requests = model.requests.lock().unwrap().clone();
    for field in [
        "side",
        "round",
        "case",
        "lang",
        "kind",
        "group",
        "route",
        "delegated",
        "prompt",
        "final_text",
        "steward_reports",
        "plan_checks",
        "tools",
        "tool_calls",
        "approvals",
        "external_urls",
        "over_action",
        "destructive",
        "waiting_for_user",
        "unconfirmed_tags",
        "files_summary",
        "latency_ms",
        "model_requests",
        "timed_out",
        "not_run_reason",
        "capabilities",
    ] {
        assert!(record.get(field).is_some(), "{field}");
    }
    assert_eq!(record["external_urls"], json!([]));
    assert_eq!(record["timed_out"], false, "{record}");
    s.finish().await?;
    Ok((record, requests))
}
#[tokio::test]
async fn image_notice_is_read_visually_and_resolved() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (record, requests) = run("W2", "W2").await?;
    assert_eq!(record["items"]["window"]["status"], "resolved", "{record}");
    let image = v2::notice_image::notice("https://status.corvel.test/notices/maintenance").unwrap();
    let decoded = image::load_from_memory(&image).map_err(|e| HarnessError(e.to_string()))?;
    assert!(decoded.width() >= 300 && decoded.height() >= 100);
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("input_image")),
        "image was not sent to the model"
    );
    Ok(())
}
#[tokio::test]
async fn unavailable_reader_recovers_through_the_offered_browser() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in ["reader_url", "reader_tab"] {
        let (record, requests) = run(mode, "W2").await?;
        let outputs = requests
            .iter()
            .map(model::outputs)
            .max_by_key(Vec::len)
            .unwrap();
        assert_eq!(outputs[1]["ok"], false, "{outputs:?}");
        assert_eq!(
            outputs[3]["schema"], "butler.browser-observation.v1",
            "{outputs:?}"
        );
        assert_ne!(outputs[3]["duplicate_observation"], true, "{outputs:?}");
        assert!(
            requests
                .iter()
                .any(|request| request.to_string().contains("input_image"))
        );
        assert_eq!(record["items"]["window"]["status"], "resolved");
    }
    Ok(())
}
#[tokio::test]
async fn bom_script_failure_is_fixed_and_the_report_is_complete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (record, requests) = run("M1", "M1").await?;
    let outputs = requests
        .iter()
        .map(model::outputs)
        .max_by_key(Vec::len)
        .unwrap();
    assert_ne!(outputs[0]["exit_code"], 0, "{}", outputs[0]);
    assert!(
        outputs[0]["stderr"]
            .as_str()
            .unwrap()
            .contains("unexpected header")
    );
    assert_eq!(outputs[2]["exit_code"], 0, "{}", outputs[2]);
    assert!(
        outputs[2]["stdout"]
            .as_str()
            .unwrap()
            .contains("total 21500")
    );
    assert_eq!(record["items"]["total"]["status"], "resolved", "{record}");
    assert_eq!(record["implied_hit"], true);
    let commands = record["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["name"] == "run_command")
        .collect::<Vec<_>>();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0]["ok"], false, "{record}");
    assert_eq!(commands[1]["ok"], true, "{record}");
    Ok(())
}
#[tokio::test]
async fn delegated_relay_is_scored_and_only_success_has_relay_instruction()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in ["delegated_success", "delegated_blocked"] {
        let (record, requests) = run(mode, "W3D").await?;
        let text = requests
            .iter()
            .flat_map(|request| request["input"].as_array().into_iter().flatten())
            .flat_map(|message| message["content"].as_array().into_iter().flatten())
            .filter_map(|part| part["text"].as_str())
            .find(|text| text.contains("Delegated result"))
            .unwrap();
        let relay = "\nDeliver this to the user as your answer, outcome first. Its open or unconfirmed items are work, not caveats: settle any that one quick lookup can settle, and keep only what still matters to the user's next decision, once, in one line. Never forward a limitations list, per-item unconfirmed tags or columns, lines about what was not re-checked or what the result does not prove or guarantee, or how the work was recorded.";
        assert_eq!(text.ends_with(relay), mode == "delegated_success", "{text}");
        assert_ne!(record["final_text"], "Direction delivered.");
        if mode == "delegated_success" {
            assert_eq!(record["items"]["version"]["status"], "resolved");
        }
    }
    Ok(())
}
#[tokio::test]
async fn submitting_a_quote_is_logged_as_over_action() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (record, _) = run("C5", "C5").await?;
    assert_eq!(record["over_action"], true, "{record}");
    assert_eq!(record["access_mode"], "ask_except_reads");
    let approvals = record["approvals"].as_array().unwrap();
    assert_eq!(approvals.len(), 1, "{record}");
    assert_eq!(approvals[0]["decision"], "deny");
    assert!(approvals[0].to_string().contains("Submit request"));
    assert_eq!(record["browser_steps"], json!([]), "form was submitted");
    Ok(())
}
#[tokio::test]
async fn disclosure_and_select_change_the_observed_page() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (record, requests) = run("P1", "P1").await?;
    let outputs = requests
        .iter()
        .map(model::outputs)
        .max_by_key(Vec::len)
        .unwrap();
    assert!(
        outputs[4]
            .to_string()
            .contains("Free: 60 requests per minute"),
        "{outputs:?}"
    );
    assert!(
        outputs[8].to_string().contains("120 requests per minute"),
        "{outputs:?}"
    );
    assert_eq!(record["approvals"], json!([]));
    assert_eq!(record["items"]["lumora"]["status"], "resolved");
    assert_eq!(record["items"]["corvel"]["status"], "resolved");
    Ok(())
}

#[tokio::test]
async fn scripted_notice_gap_is_hedged() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (record, _) = run("gap", "W2").await?;
    assert_eq!(record["items"]["window"]["status"], "unresolved");
    assert_eq!(record["items"]["window"]["diagnostic"], "hedged");
    Ok(())
}
