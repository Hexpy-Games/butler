//! Offline measurement through the real runtime. Fixtures remain outside the repository.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod diag;
mod fixture;
mod host;
mod markup;
mod policy;
mod report;
mod steps;

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    config::ModelChoice,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};

#[tokio::test]
#[ignore = "external research snapshots; measurement only"]
async fn research_eval_report() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let root = PathBuf::from(
        std::env::var("BUTLER_RESEARCH_EVAL_DIR")
            .map_err(|_| HarnessError("BUTLER_RESEARCH_EVAL_DIR is required".into()))?,
    );
    let out = PathBuf::from(
        std::env::var("BUTLER_RESEARCH_EVAL_OUT")
            .map_err(|_| HarnessError("BUTLER_RESEARCH_EVAL_OUT is required".into()))?,
    );
    let sets = std::env::var("BUTLER_RESEARCH_EVAL_SETS")
        .unwrap_or("tasks,holdout,deep,deep-holdout".into());
    let mut rows = Vec::new();
    for set in sets.split(',').map(str::trim) {
        assert!(
            !set.is_empty()
                && std::path::Path::new(set).components().count() == 1
                && matches!(
                    std::path::Path::new(set).components().next(),
                    Some(std::path::Component::Normal(_))
                ),
            "evaluation set must name a directory under the fixture root"
        );
        let directory = root.join(set);
        let mut paths = std::fs::read_dir(directory)?
            .map(|e| e.map(|e| e.path()))
            .collect::<Result<Vec<_>, _>>()?;
        paths.sort();
        assert!(!paths.is_empty(), "evaluation set is empty");
        for (index, path) in paths.into_iter().filter(|p| p.is_dir()).enumerate() {
            let task = tokio::task::spawn_blocking(move || fixture::Task::load(&path))
                .await
                .map_err(|e| HarnessError(e.to_string()))??;
            let mut row = run(Arc::new(task), set).await?;
            if blind(set) {
                report::redact(&mut row, set, index + 1);
            }
            rows.push(row);
        }
    }
    let markdown = report::markdown(&rows);
    let output = json!({"pricing_model":"openai/gpt-6.1-sol", "tasks":rows,
        "summary":report::summary(&rows)});
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        std::fs::create_dir_all(&out)?;
        std::fs::write(out.join("report.json"), serde_json::to_vec_pretty(&output)?)?;
        std::fs::write(out.join("report.md"), &markdown)?;
        eprintln!("{markdown}");
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    Ok(())
}

fn blind(set: &str) -> bool {
    set.contains("holdout")
}

async fn run(task: Arc<fixture::Task>, set: &str) -> Result<Value, HarnessError> {
    let diagnostic = diag::directory(&task, set);
    let fixture = fixture::Fixture::start(task.clone()).await?;
    let s = Setup::new("RESEARCH-EVAL")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env(
            "BUTLER_CHATGPT_API_BASE_URL",
            format!("{}/v1", fixture.base),
        )
        .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key")
        .start()
        .await?;
    s.select_model(&ModelChoice::parse("openai/gpt-6.1-sol@low").unwrap())
        .await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    configure_search(&s, &fixture.base).await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let browser = host::Host::attach(admin, task.clone(), diagnostic.is_some()).await?;
    let browser_log = browser.log.clone();
    let served = browser.start();
    s.turn("general", task.spec["request"].as_str().unwrap())
        .await?;
    let completed = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let answer = fixture.state.lock().unwrap().answer.clone();
            if let Some(answer) = answer {
                let messages = s.gw.messages("general").await?;
                if messages.iter().any(|m| m["text"] == answer) {
                    return Ok::<_, HarnessError>(answer);
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    drop(served);
    let row = match completed {
        Ok(Ok(answer)) => report::measure(&task, set, &fixture.state.lock().unwrap(), &answer),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(HarnessError(
            "research task did not complete (fixture details suppressed)".into(),
        )),
    };
    if let Some(directory) = diagnostic {
        let captured = {
            let state = fixture.state.lock().unwrap();
            json!({"exchanges":state.exchanges,
                "browser":browser_log.unwrap().lock().unwrap().clone(),
                "answer":state.answer,"row":row.as_ref().ok()})
        };
        diag::save(&task, directory, captured).await?;
    }
    s.finish().await?;
    row
}

async fn configure_search(s: &Scenario, base: &str) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("butler.config.json");
    let base = base.to_owned();
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        config["webSearch"] = json!({"provider":"brave", "readerBackend":"browser", "planning":{"enabled":false},
            "braveApiBase":format!("{base}/search")});
        std::fs::write(path, serde_json::to_vec(&config)?)?;
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}
