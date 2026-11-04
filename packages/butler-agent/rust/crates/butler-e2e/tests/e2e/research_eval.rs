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

mod run;

use butler_e2e::e2e::HarnessError;
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

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
    let only = std::env::var("BUTLER_RESEARCH_EVAL_ONLY").ok();
    let mut rows = Vec::new();
    for set in sets.split(',').map(str::trim) {
        assert!(
            !set.is_empty()
                && std::path::Path::new(set).components().count() == 1
                && matches!(
                    std::path::Path::new(set).components().next(),
                    Some(std::path::Component::Normal(_))
                ),
            "set must name a directory under the fixture root"
        );
        let mut paths = std::fs::read_dir(root.join(set))?
            .map(|e| e.map(|e| e.path()))
            .collect::<Result<Vec<_>, _>>()?;
        paths.sort();
        assert!(!paths.is_empty(), "evaluation set is empty");
        for (index, path) in paths.into_iter().filter(|p| p.is_dir()).enumerate() {
            let label = if blind(set) {
                format!("{set}/{}", index + 1)
            } else {
                path.file_name().unwrap().to_string_lossy().into_owned()
            };
            if only.as_ref().is_some_and(|only| only != &label) {
                continue;
            }
            eprintln!("research_eval {label}: started");
            let task = tokio::task::spawn_blocking(move || fixture::Task::load(&path)).await;
            let mut row = match task {
                Ok(Ok(task)) => run::task(Arc::new(task), set, &out).await.unwrap_or_else(|error|
                    json!({"id":label,"set":set,"status":"incomplete","completed":false,"error":error.to_string()})),
                Ok(Err(error)) => json!({"id":label,"set":set,"status":"incomplete","completed":false,
                    "error":error.to_string()}),
                Err(error) => json!({"id":label,"set":set,"status":"incomplete","completed":false,"error":error.to_string()}),
            };
            if blind(set) {
                report::redact(&mut row, set, index + 1);
            }
            eprintln!("research_eval {label}: {}", row["status"]);
            rows.push(row);
            report::write(&rows, &out, false).await?;
        }
    }
    assert!(!rows.is_empty(), "no evaluation tasks matched");
    report::write(&rows, &out, true).await?;
    report::require_complete(&rows)
}
fn blind(set: &str) -> bool {
    set.contains("holdout")
}
