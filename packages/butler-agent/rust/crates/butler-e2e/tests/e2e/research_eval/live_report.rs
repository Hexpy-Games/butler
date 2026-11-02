use super::live_proxy::{Spend, Traffic};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex},
};

pub(super) fn row(traffic: &Traffic) -> Value {
    let requests = traffic
        .requests
        .iter()
        .filter(|r| r["lane"] != "judge")
        .collect::<Vec<_>>();
    let mut calls = BTreeMap::<&str, usize>::new();
    for r in &requests {
        *calls.entry(r["lane"].as_str().unwrap()).or_default() += 1;
    }
    let sum_usage = |key: &str| {
        requests
            .iter()
            .filter_map(|r| r["usage"][key].as_u64())
            .sum::<u64>()
    };
    let mut row = json!({"calls":requests.len(),"calls_per_lane":calls,
        "runaway":traffic.budget.runaway,"offline_misses":traffic.offline_misses.len(),
        "input":sum_usage("prompt_tokens"),"cached":sum_usage("prompt_cache_hit_tokens"),
        "uncached":sum_usage("prompt_cache_miss_tokens"),"output":sum_usage("completion_tokens"),
        "external_requests_refused":traffic.refused_hosts.len(),
        "rejected_model_requests":traffic.rejected_model_requests,
        "provider_errors":traffic.requests.iter().filter(|r|r["http_status"].as_u64().is_some_and(|s|s >= 400)).count(),
        "provider_rejected_requests":traffic.requests.iter().filter(|r|r["rejected_before_inference"] == true).count(),
        "unknown_host_ops":traffic.unknown_host_ops,
        "host_executor_errors":traffic.host_errors.len(),
        "host_reader_replies":traffic.host_reader_replies,
        "browser_page_outputs":traffic.browser_page_outputs,
        "nonbrowser_page_outputs":traffic.nonbrowser_page_outputs,
        "usage_complete":traffic.pending == 0 && traffic.requests.iter().all(super::live_usage::accounted),
        "requests":traffic.requests});
    for key in ["usd", "sol_usd"] {
        row[key] = json!(requests.iter().filter_map(|r| r[key].as_f64()).sum::<f64>());
    }
    row["judge_usd"] = json!(
        traffic
            .requests
            .iter()
            .filter(|r| r["lane"] == "judge")
            .filter_map(|r| r["usd"].as_f64())
            .sum::<f64>()
    );
    row
}
fn median(mut values: Vec<f64>) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n == 0 {
        None
    } else if n.is_multiple_of(2) {
        Some(values[n / 2 - 1].midpoint(values[n / 2]))
    } else {
        Some(values[n / 2])
    }
}
fn medians(rows: &[&Value]) -> Value {
    let mut result = json!({});
    for key in [
        "usd",
        "sol_usd",
        "facts_answered",
        "facts_received",
        "input",
        "cached",
        "uncached",
        "output",
        "wall_seconds",
    ] {
        result[key] = json!(median(
            rows.iter().filter_map(|r| r[key].as_f64()).collect()
        ));
    }
    result
}
pub(super) fn summary(rows: &[Value], spend: &Spend) -> Value {
    let sets = rows
        .iter()
        .filter_map(|r| r["set"].as_str())
        .collect::<BTreeSet<_>>();
    let per_set: BTreeMap<_, _> = sets
        .iter()
        .map(|set| {
            (
                *set,
                medians(&rows.iter().filter(|r| r["set"] == *set).collect::<Vec<_>>()),
            )
        })
        .collect();
    json!({"median_per_set":per_set,"median_overall":medians(&rows.iter().collect::<Vec<_>>()),
        "total_real_usd_including_judge":spend.total,"judge_usd":spend.judge,
        "task_usd":spend.total-spend.judge,"spend_limit_usd":spend.max,
        "stopped_spend_guard":spend.stopped(),
        "runaway_tasks":rows.iter().filter(|r|r["runaway"] == true).count(),
        "offline_misses":rows.iter().filter_map(|r|r["offline_misses"].as_u64()).sum::<u64>(),
        "cost_accounting_complete":rows.iter().all(|r|r["usage_complete"] == true),
        "asks_answered":rows.iter().filter_map(|r|r["asks_answered"].as_u64()).sum::<u64>(),
        "approvals_given":rows.iter().filter_map(|r|r["approvals_given"].as_u64()).sum::<u64>(),
        "host_executor_errors":rows.iter().filter_map(|r|r["host_executor_errors"].as_u64()).sum::<u64>(),
        "unknown_host_ops":rows.iter().filter_map(|r|r["unknown_host_ops"].as_u64()).sum::<u64>(),
        "provider_errors":rows.iter().filter_map(|r|r["provider_errors"].as_u64()).sum::<u64>(),
        "external_requests_refused":rows.iter().filter_map(|r|r["external_requests_refused"].as_u64()).sum::<u64>()})
}
pub(super) fn markdown(rows: &[Value], summary: &Value) -> String {
    let mut text = "| Task | Status | Runaway | Offline misses | Answered/received/total | Calls B/S/W | Input cached/uncached | Output | DeepSeek USD | Sol USD | Asks/approvals | Provider errors | Unknown host ops | Refused | Seconds |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n".to_owned();
    for r in rows {
        let lane = |l: &str| r["calls_per_lane"][l].as_u64().unwrap_or(0);
        text.push_str(&format!(
            "| {} | {} | {} | {} | {}/{}/{} | {}/{}/{} | {}/{} | {} | {:.6} | {:.6} | {}/{} | {} | {} | {} | {:.1} |\n",
            r["id"].as_str().unwrap(),
            r["status"].as_str().unwrap(),
            usize::from(r["runaway"] == true),
            r["offline_misses"],
            r["facts_answered"],
            r["facts_received"],
            r["facts_total"],
            lane("butler"),
            lane("steward"),
            lane("worker"),
            r["cached"],
            r["uncached"],
            r["output"],
            r["usd"].as_f64().unwrap_or(0.0),
            r["sol_usd"].as_f64().unwrap_or(0.0),
            r["asks_answered"],
            r["approvals_given"],
            r["provider_errors"],
            r["unknown_host_ops"],
            r["external_requests_refused"],
            r["wall_seconds"].as_f64().unwrap()
        ));
    }
    text.push_str(&format!(
        "\nSummary:\n```json\n{}\n```\n",
        serde_json::to_string_pretty(summary).unwrap()
    ));
    text
}
pub(super) async fn write(
    rows: &[Value],
    out: &Path,
    spend: Arc<Mutex<Spend>>,
) -> Result<(), HarnessError> {
    let summary = summary(rows, &spend.lock().unwrap());
    let markdown = markdown(rows, &summary);
    let report = json!({"tasks":rows,"summary":summary,
        "task_limits":{"max_usd":super::live_limits::TaskBudget::from_env()?.max_usd,
            "max_calls":super::live_limits::TaskBudget::from_env()?.max_calls},
        "network_isolation":std::env::var("BUTLER_RESEARCH_EVAL_NETWORK_ISOLATION").ok(),
        "measurement":"Provider-reported usage; completion_tokens includes reasoning; judge excluded from task costs. HTTP 400/401/402/422/429 are pre-inference rejections: absent usage is preserved and zero inference cost is recorded separately.",
        "offline":"Saved Brave results, exact query or ranked saved corpus. Page reader forced to browser. The in-worktree App executor runs in isolated test Electron. HTTP(S) protocol handlers fulfill saved HTML; public host resolution is synthetic without DNS; missing snapshots return small HTTP 404 Not Found pages and are counted as offline_misses. The App private-address guards remain active. Lifecycle, observations, navigation and screenshots use the App implementation. Unknown host operations retain the product refusal and are counted. Agent HTTP(S)/ALL proxy refuses and counts requests reaching it. Private login-shell profile restores proxy variables filtered by command tools. Default read-only and project-write command sandboxes deny network. App and headless native-browser fallbacks are disabled in the E2E launcher."});
    let out = out.to_owned();
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        save(
            &out.join("report.json"),
            &serde_json::to_vec_pretty(&report)?,
        )?;
        save(&out.join("report.md"), markdown.as_bytes())?;
        scan(&out)?;
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}
/// Check before writing and scan every report artifact afterwards. Never print a match.
pub(super) fn save(path: &Path, bytes: &[u8]) -> Result<(), HarnessError> {
    check(bytes)?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, bytes)?;
    Ok(())
}
fn check(bytes: &[u8]) -> Result<(), HarnessError> {
    let name = std::env::var("BUTLER_E2E_API_KEY_ENV").unwrap_or("DEEPSEEK_API_KEY".into());
    let key = std::env::var(name)
        .map_err(|_| HarnessError("artifact credential check unavailable".into()))?;
    if key.is_empty() || bytes.windows(key.len()).any(|w| w == key.as_bytes()) {
        return Err(HarnessError(
            "credential found in artifact; run failed".into(),
        ));
    }
    Ok(())
}
fn scan(path: &Path) -> Result<(), HarnessError> {
    for entry in std::fs::read_dir(path)? {
        let path = entry?.path();
        if path.is_dir() {
            scan(&path)?;
        } else {
            check(&std::fs::read(path)?)?;
        }
    }
    Ok(())
}
