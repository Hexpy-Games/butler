//! Opt-in visible-set evidence capture. Probes never feed the simulated model.
use super::fixture::Task;
use butler_e2e::e2e::HarnessError;
use butler_runtime::web_access::{LivePage, testing};
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf};
use tokio_util::sync::CancellationToken;

pub(super) fn directory(task: &Task, set: &str) -> Option<PathBuf> {
    if set != "tasks" {
        return None;
    }
    let root = PathBuf::from(std::env::var_os("BUTLER_RESEARCH_EVAL_DIAG")?);
    let id = task.spec["id"].as_str().unwrap();
    assert!(
        std::path::Path::new(id)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    );
    Some(root.join(id))
}

pub(super) async fn save(
    task: &Task,
    directory: PathBuf,
    captured: Value,
) -> Result<(), HarnessError> {
    let mut pages = Vec::new();
    let data = std::env::temp_dir().join(format!("research-probe-{}", uuid::Uuid::new_v4()));
    let access = testing::access(data.clone(), "http://127.0.0.1:1/search");
    for (url, (_, html)) in &task.pages {
        let session = access.session_for_turn(String::new());
        let mut windows = Vec::new();
        let mut visited = HashSet::new();
        let mut cursor = 0;
        while visited.insert(cursor) {
            let live = LivePage {
                tab: "probe".into(),
                epoch: 1,
                final_url: url.clone(),
                html: html.clone(),
            };
            let output = session
                .web_read_from(
                    &json!({"url":url,"start_chunk":cursor,"max_chars":8000,"max_chunks":8}),
                    Some(live),
                    false,
                    &CancellationToken::new(),
                )
                .await
                .map_err(|e| HarnessError(e.to_string()))?;
            let next = output["next_start_chunk"].as_u64();
            windows.push(output);
            match next {
                Some(next) => cursor = next,
                None => break,
            }
        }
        pages.push(json!({"url":url,"windows":windows}));
    }
    let spec = task.spec.clone();
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        std::fs::create_dir_all(&directory)?;
        for (name, value) in [
            ("capture.json", captured),
            ("extraction.json", json!(pages)),
            ("task.json", spec),
        ] {
            std::fs::write(directory.join(name), serde_json::to_vec_pretty(&value)?)?;
        }
        if data.exists() {
            std::fs::remove_dir_all(data)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}
