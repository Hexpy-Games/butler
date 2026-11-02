use super::{
    fixture::Task,
    live_execute::{self, Outcome},
    live_proxy::{Proxy, Spend},
    live_report,
};
use butler_e2e::e2e::{HarnessError, config::LiveProvider};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

pub(super) async fn report(provider: LiveProvider) -> Result<(), HarnessError> {
    // This benchmark's explicit owner exception must not silently select another model.
    if provider.choice.model != "deepseek/deepseek-flash" || provider.provider != "deepseek" {
        return Err(HarnessError(
            "research live benchmark requires the authorized DeepSeek Flash model".into(),
        ));
    }
    let root = required_path("BUTLER_RESEARCH_EVAL_DIR")?;
    let out = required_path("BUTLER_RESEARCH_EVAL_OUT")?;
    let max = std::env::var("BUTLER_RESEARCH_EVAL_MAX_USD")
        .unwrap_or("15".into())
        .parse::<f64>()
        .map_err(|_| HarnessError("invalid spend limit".into()))?;
    if !max.is_finite() || max <= 0.0 {
        return Err(HarnessError("spend limit must be positive".into()));
    }
    let spend = Arc::new(Mutex::new(Spend {
        max,
        ..Spend::default()
    }));
    let mut rows = Vec::new();
    let sets = std::env::var("BUTLER_RESEARCH_EVAL_SETS")
        .unwrap_or("tasks,holdout,deep,deep-holdout".into());
    'sets: for set in sets.split(',').map(str::trim) {
        valid_component(set)?;
        let root = root.clone();
        let set_copy = set.to_owned();
        let paths = tokio::task::spawn_blocking(move || paths(&root, &set_copy))
            .await
            .map_err(|_| HarnessError("fixture listing failed".into()))??;
        for (index, path) in paths.into_iter().enumerate() {
            let label = if super::blind(set) {
                format!("{set}/{}", index + 1)
            } else {
                path.file_name().unwrap().to_string_lossy().into_owned()
            };
            if let Ok(only) = std::env::var("BUTLER_RESEARCH_EVAL_ONLY")
                && path.file_name().and_then(|p| p.to_str()) != Some(only.as_str())
            {
                continue;
            }
            eprintln!("research_eval_live {label}: started");
            let task = tokio::task::spawn_blocking(move || Task::load(&path))
                .await
                .map_err(|_| HarnessError("fixture loading failed".into()))?
                .map_err(|_| HarnessError("fixture loading failed".into()))?;
            let row = task_run(
                provider.clone(),
                Arc::new(task),
                set,
                &label,
                &out,
                spend.clone(),
            )
            .await?;
            eprintln!("research_eval_live {label}: {}", row["status"]);
            rows.push(row);
            live_report::write(&rows, &out, spend.clone()).await?;
            if spend.lock().unwrap().stopped()
                || rows.last().unwrap()["usage_complete"] != true
                || rows.last().unwrap()["rejected_model_requests"] != 0
            {
                break 'sets;
            }
        }
    }
    if rows.is_empty() {
        return Err(HarnessError("no evaluation tasks selected".into()));
    }
    let summary = live_report::summary(&rows, &spend.lock().unwrap());
    eprintln!("{}", live_report::markdown(&rows, &summary));
    if rows.iter().any(|r| r["status"] != "complete") {
        return Err(HarnessError(
            "live benchmark has incomplete tasks; numeric report written".into(),
        ));
    }
    Ok(())
}
async fn task_run(
    provider: LiveProvider,
    task: Arc<Task>,
    set: &str,
    label: &str,
    out: &Path,
    spend: Arc<Mutex<Spend>>,
) -> Result<Value, HarnessError> {
    let started = Instant::now();
    let proxy = Proxy::start(&provider, task.clone(), spend.clone()).await?;
    let mut outcome = live_execute::execute(provider.clone(), task.clone(), &proxy)
        .await
        .unwrap_or_else(|e| Outcome {
            status: "incomplete".into(),
            answer: String::new(),
            host_reads: 0,
            asks_answered: 0,
            approvals_given: 0,
            error: Some(e.to_string()),
        });
    let settled = proxy.settle().await;
    if !settled {
        outcome.status = "incomplete".into();
    }
    let can_judge = settled && !spend.lock().unwrap().stopped();
    let answered = if outcome.status == "runaway" && outcome.answer.is_empty() {
        Some(0)
    } else if can_judge {
        match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            super::live_judge::judge(&provider, &task, &outcome.answer, &proxy),
        )
        .await
        {
            Ok(Ok(count)) => Some(count),
            _ => {
                outcome.status = "incomplete".into();
                outcome.error = Some("judge failed".into());
                None
            }
        }
    } else {
        None
    };
    if !proxy.settle().await {
        outcome.status = "incomplete".into();
    }
    let stopped = spend.lock().unwrap().stopped();
    let (mut row, captured) = {
        let traffic = proxy.traffic.lock().unwrap();
        let mut row = live_report::row(&traffic);
        if stopped {
            outcome.status = "stopped_spend_guard".into();
        } else if traffic.budget.runaway {
            outcome.status = "runaway".into();
        } else if row["usage_complete"] != true
            || traffic.nonbrowser_page_outputs > 0
            || (traffic.browser_page_outputs > 0 && outcome.host_reads == 0)
        {
            outcome.status = "incomplete".into();
        }
        row["id"] = json!(label);
        row["set"] = json!(set);
        row["status"] = json!(outcome.status);
        row["facts_answered"] = json!(answered);
        row["facts_kept"] = json!(answered);
        row["facts_received"] = json!(traffic.received.len());
        row["facts_total"] = json!(task.spec["facts"].as_array().unwrap().len());
        row["wall_seconds"] = json!(started.elapsed().as_secs_f64());
        row["asks_answered"] = json!(outcome.asks_answered);
        row["approvals_given"] = json!(outcome.approvals_given);
        row["snapshot_host_reads"] = json!(outcome.host_reads);
        let captured = if super::blind(set) {
            None
        } else {
            row["tool_call_histogram"] = traffic.budget.top_tools();
            row["offline_miss_urls"] = json!(traffic.offline_misses);
            row["host_executor_error_messages"] = json!(traffic.host_errors);
            row["host_op_counts"] = json!(traffic.host_ops);
            row["refused_hosts"] = json!(traffic.refused_hosts);
            row["error"] = json!(outcome.error);
            Some(json!({"answer":outcome.answer,"requests":traffic.requests,"row":row}))
        };
        (row, captured)
    };
    if let Some(captured) = captured {
        let path = out.join("diag").join(set).join(label).join("task.json");
        tokio::task::spawn_blocking(move || {
            live_report::save(&path, &serde_json::to_vec_pretty(&captured)?)
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
    } else {
        row.as_object_mut().unwrap().remove("requests");
    }
    Ok(row)
}
fn required_path(name: &str) -> Result<PathBuf, HarnessError> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| HarnessError(format!("{name} is required")))
}
fn valid_component(name: &str) -> Result<(), HarnessError> {
    let mut parts = Path::new(name).components();
    if !matches!(parts.next(), Some(std::path::Component::Normal(_))) || parts.next().is_some() {
        return Err(HarnessError(
            "fixture set must be one directory component".into(),
        ));
    }
    Ok(())
}
fn paths(root: &Path, set: &str) -> Result<Vec<PathBuf>, HarnessError> {
    let mut paths = std::fs::read_dir(root.join(set))?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.retain(|p| p.is_dir());
    paths.sort();
    if paths.is_empty() {
        return Err(HarnessError("empty evaluation set".into()));
    }
    Ok(paths)
}
