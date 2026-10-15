//! Opt-in, paired eval v2. Stub tests exercise the same fixtures and collector.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
pub(crate) mod cases;
pub(crate) mod collect;
pub(crate) mod files;
pub(crate) mod host;
#[allow(
    unreachable_pub,
    reason = "Shared public library API compiled in the standalone main overlay"
)]
#[path = "../../../src/e2e/hedge.rs"]
mod lint;
pub(crate) mod notice_image;
pub(crate) mod pairs;
pub(crate) mod preflight;
pub(crate) mod score;
pub(crate) mod web;

use butler_e2e::e2e::{
    HarnessError, live,
    scenario::{Access, Setup},
};
pub(crate) const EVAL_ACCESS: Access = Access::AskExceptReads;
pub(crate) const EVAL_ACCESS_MODE: &str = "ask_except_reads";

use cases::{CASES, Case};
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{Arc, Mutex},
};

#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_12_hedge_v2() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_HEDGE_EVAL").as_deref() == Ok("1"),
        "on-demand hedge eval requires BUTLER_E2E_HEDGE_EVAL=1"
    );
    let Some(provider) = live::gate("LIVE-12")? else {
        return Ok(());
    };
    let _ = pairs::JUDGE_PROMPT;
    let selected = std::env::var("BUTLER_E2E_HEDGE_CASES").unwrap_or_default();
    let search = web::Search::start().await?;
    for case in CASES
        .iter()
        .filter(|c| selected.is_empty() || selected.split(',').any(|id| id == c.id))
    {
        search.activate(case.id);
        let cache =
            std::env::var("BUTLER_E2E_BROWSER_CACHE").map_err(|e| HarnessError(e.to_string()))?;
        let setup = Setup::new(&format!("HEDGE-V2-{}", case.id))?
            .live(provider.clone())
            .access(EVAL_ACCESS)
            .env("BUTLER_E2E_APP_NOW", "2026-10-14T00:00:00Z")
            .env("BUTLER_WEB_READER_BACKEND", "disabled")
            .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key")
            .env(
                "BUTLER_BROWSER_HEADLESS",
                if case.group == "web" { "off" } else { "on" },
            )
            .env("BUTLER_BROWSER_CACHE_DIR", cache)
            .env("BUTLER_BROWSER_DOWNLOAD_BASE", "http://127.0.0.1:9/");
        let s = setup.start().await?;
        configure(&s, &search.base).await?;
        let language = response_language(&s, case).await?;
        let image = preflight::image_input(&s).await?;
        let checker = if case.group == "workspace" {
            preflight::output(&s).await?
        } else {
            true
        };
        let mut record =
            if (case.id == "W2" && !image) || (matches!(case.id, "A1" | "D2") && !checker) {
                not_run(
                    case,
                    if checker {
                        "image_input_unavailable"
                    } else {
                        "check_unavailable"
                    },
                )
            } else {
                let (log, served) = if case.group == "web" {
                    let host = host::Host::attach(preflight::admin(&s)).await?;
                    (host.log.clone(), Some(tokio::spawn(host.serve())))
                } else {
                    (Arc::new(Mutex::new(host::Log::default())), None)
                };
                let result = collect::run(&s, case, log).await;
                if let Some(served) = served {
                    served.abort();
                }
                result?
            };
        if case.id == "D1" && !image {
            record["not_scored"] = json!(["corvel"]);
        }
        record["response_language"] = json!(language);
        preflight::artifacts(&s, &mut record).await?;
        score::score(&mut record);
        record["reference"] = json!(case.reference);
        record["delegation_requested"] = json!(case.delegated);
        write(record).await?;
        s.finish().await?;
    }
    Ok(())
}
pub(crate) async fn configure(
    s: &butler_e2e::e2e::scenario::Scenario,
    base: &str,
) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("butler.config.json");
    let base = base.to_owned();
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        config["webSearch"] = json!({"provider":"brave","braveApiBase":base,"planning":{"enabled":false},
            "readerBackend":"disabled","readerBackendRevision":2});
        std::fs::write(path, serde_json::to_vec(&config)?)?;
        Ok(())
    }).await.map_err(|e| HarnessError(e.to_string()))?
}
/// Answers in the case's language, as an owner with that response language
/// would get (LIVE-01): both sides set it identically and record what resolved.
pub(crate) async fn response_language(
    s: &butler_e2e::e2e::scenario::Scenario,
    case: &Case,
) -> Result<String, HarnessError> {
    let reply =
        s.gw.patch("/personalization", json!({"response_language": case.lang}))
            .await?;
    if reply.status != 200 {
        return Err(HarnessError(format!(
            "response_language update failed: {}",
            reply.text
        )));
    }
    let view = s.gw.get("/personalization").await?;
    let language = view.data()["response_language"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if language != case.lang {
        return Err(HarnessError(format!(
            "{} resolved response language {language:?}, expected {}",
            case.id, case.lang
        )));
    }
    Ok(language)
}
fn not_run(case: &Case, reason: &str) -> Value {
    json!({"side":std::env::var("BUTLER_E2E_HEDGE_SIDE").unwrap_or_else(|_|"branch".into()),
        "round":std::env::var("BUTLER_E2E_HEDGE_ROUND").ok().and_then(|v|v.parse::<u32>().ok()).unwrap_or(1),
        "access_mode":EVAL_ACCESS_MODE,"case":case.id,"lang":case.lang,"kind":case.kind,"group":case.group,"route":case.route,
        "delegated":false,"prompt":case.prompt,"final_text":"","steward_reports":[],"plan_checks":[],
        "tools":[],"tool_calls":{"total":0,"by_name":{}},"approvals":[],"external_urls":[],
        "over_action":false,"destructive":false,"waiting_for_user":false,"unconfirmed_tags":0,
        "files_summary":"","latency_ms":0,"model_requests":null,"timed_out":false,
        "not_run_reason":reason,"capabilities":"","delivered":false,"file_checks":{}})
}
async fn write(record: Value) -> Result<(), HarnessError> {
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let path =
            std::env::var("BUTLER_E2E_HEDGE_OUT").map_err(|e| HarnessError(e.to_string()))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(file, "{record}")?;
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}

#[tokio::test]
#[ignore = "Chromium prewarm utility"]
async fn prewarm_shared_chromium() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_HEDGE_EVAL").as_deref() == Ok("1"),
        "on-demand hedge eval requires BUTLER_E2E_HEDGE_EVAL=1"
    );
    let cache =
        std::env::var("BUTLER_E2E_BROWSER_CACHE").map_err(|e| HarnessError(e.to_string()))?;
    let s = Setup::new("HEDGE-V2-PREWARM")?
        .stub_cassette(butler_e2e::e2e::cassette::Cassette::load("TOOL-01")?)
        .env("BUTLER_BROWSER_HEADLESS", "on")
        .env("BUTLER_BROWSER_CACHE_DIR", cache)
        .start()
        .await?;
    let id = preflight::probe(&s).await?;
    let view = s.gw.get(&format!("/outputs/{id}/view")).await?;
    if view.status != 200 {
        return Err(HarnessError("Prewarm output view unavailable".into()));
    }
    let url = view.data()["url"].as_str().unwrap();
    let admin = preflight::admin(&s);
    let begin = std::time::Instant::now();
    loop {
        let reply = admin
            .send(
                reqwest::Method::POST,
                "/internal/browser/calls",
                Some(json!({"op":"tab.open","session":"general","args":{"url":url}})),
                &[],
            )
            .await?;
        if reply.body["reason"] != "browser_installing" {
            if reply.body["status"] != "ok" {
                return Err(HarnessError(format!(
                    "Chromium prewarm failed: {}",
                    reply.body
                )));
            }
            break;
        }
        if begin.elapsed() >= std::time::Duration::from_mins(15) {
            return Err(HarnessError("Chromium prewarm timed out".into()));
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    let report = preflight::check(&s, &id).await?;
    if report["status"] != "ok" || report["errors"]["total"] != 0 {
        return Err(HarnessError(format!(
            "Prewarm output check failed: {report}"
        )));
    }
    s.finish().await
}
