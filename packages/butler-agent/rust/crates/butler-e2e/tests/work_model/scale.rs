use super::{recursive, work_model::*};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::process_control::usage;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
#[path = "scale_activation.rs"]
mod activation;
#[path = "scale_instructions.rs"]
mod instructions;
#[path = "scale_seed.rs"]
mod seed;

fn p95(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[(samples.len() * 95 / 100).min(samples.len() - 1)]
}
fn report_samples(label: &str, samples: &[Duration]) {
    let mut ordered = samples.to_vec();
    ordered.sort();
    let median = ordered[ordered.len() / 2];
    eprintln!("WM-13 {label} p50={:?} p95={:?}", median, p95(ordered));
}
async fn get(s: &Scenario, path: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(path).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

async fn fixture(id: &str) -> Result<(Scenario, String, String), HarnessError> {
    let (mut s, instruction) = setup(id).await?;
    let mut bundle = recursive::bundle(10_000);
    for node in bundle["nodes"].as_array_mut().unwrap() {
        for c in 1..5 {
            node["criteria"].as_array_mut().unwrap().push(json!({"id":format!("unplanned-{c}"),"part_id":"API","text":"Complete criterion","verification":"Exact fixture"}));
        }
    }
    for i in 6..15 {
        bundle["tasks"][i]["after"]
            .as_array_mut()
            .unwrap()
            .push(json!("t0"));
    }
    let began = Instant::now();
    let publication_before = usage::sample(s.agent.pid().unwrap())?.unwrap();
    let receipt=apply(&s,json!({"instruction_id":instruction,"idempotency_key":"scale-create","command":{"op":"create","bundle":bundle}})).await?;
    assert_eq!(receipt["ok"], true, "{receipt}");
    eprintln!("WM-13 initial publication+activation {:?}", began.elapsed());
    let publication_after = usage::sample(s.agent.pid().unwrap())?.unwrap();
    eprintln!(
        "WM-13 setup whole-process write_chars={} disk_write_bytes={} Ledger_retained_bytes={}",
        publication_after.write_chars.unwrap() - publication_before.write_chars.unwrap(),
        publication_after.write_bytes - publication_before.write_bytes,
        seed::ledger_bytes(&s)?
    );
    let plan = receipt["plan_id"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    seed::owner_scale(&s, &plan).map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    s.gw = s.agent.start_again().await?;
    Ok((s, instruction, plan))
}

pub(super) async fn activation_budget() -> Result<(), HarnessError> {
    let (s, _, _) = fixture("WM-13-ACTIVATION-SCALE").await?;
    activation::run(&s).await?;
    s.finish().await
}

pub(super) async fn run() -> Result<(), HarnessError> {
    let (mut s, instruction, plan) = fixture("WM-13-CORE-SCALE").await?;
    let began = Instant::now();
    let cold = get(&s, "/sessions/general/work-summary").await?;
    let cold_time = began.elapsed();
    check_summary(&cold, 1);
    butler_e2e::assert_wall_clock_budget!(cold_time, Duration::from_millis(250), "WM-13");
    let mut samples = Vec::new();
    for _ in 0..20 {
        let t = Instant::now();
        let v = get(&s, "/sessions/general/work-summary").await?;
        samples.push(t.elapsed());
        check_summary(&v, 1);
    }
    report_samples("Summary warm", &samples);
    let summary_p95 = p95(samples);
    butler_e2e::assert_wall_clock_budget!(summary_p95, Duration::from_millis(100), "WM-13");
    concurrent_workers(&s).await?;
    let (graph_p95, full) = graph(&s, &plan, 1).await?;
    butler_e2e::assert_wall_clock_budget!(graph_p95, Duration::from_millis(150), "WM-13");
    butler_e2e::assert_wall_clock_budget!(full, Duration::from_secs(2), "WM-13");
    let mut samples = Vec::new();
    for _ in 0..20 {
        let t = Instant::now();
        let spec = get(&s, "/sessions/general/work-spec?node_id=scale-7").await?;
        samples.push(t.elapsed());
        let nodes = spec["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 8);
        assert!(
            nodes
                .iter()
                .all(|n| n["node"]["criteria"].as_array().unwrap().len() == 5)
        );
    }
    report_samples("Spec warm", &samples);
    let spec_p95 = p95(samples);
    butler_e2e::assert_wall_clock_budget!(spec_p95, Duration::from_millis(150), "WM-13");
    let ids = cold["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .step_by(3)
        .take(2)
        .map(|t| t["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let pid = s.agent.pid().unwrap();
    let before = usage::sample(pid)?.unwrap();
    let cpu_before = usage::cpu_milliseconds(pid);
    let operations_before = get(&s, "/sessions/general/work-model-metrics").await?;
    let mut peak = before.resident_bytes;
    let mut edits = Vec::new();
    let mut dags = Vec::new();
    let mut revision = 1;
    let dag_from = cold["tasks"][0]["id"].clone();
    let dag_to = cold["tasks"][1]["id"].clone();
    for i in 0..1000 {
        let command = if i % 10 == 0 {
            json!({"op":"dependencies","add":if i%20==0 {vec![json!({"from":dag_from,"to":dag_to})]} else {vec![]},"remove":if i%20==10 {vec![json!({"from":dag_from,"to":dag_to})]} else {vec![]}})
        } else if i % 3 == 0 {
            json!({"op":"step","task_id":ids[0],"phase":if i%2==0 {"planning"} else {"execution"}})
        } else {
            json!({"op":"reorder","task_ids":if i%2==0 {vec![&ids[0],&ids[1]]} else {vec![&ids[1],&ids[0]]}})
        };
        let input = json!({"instruction_id":instruction,"idempotency_key":format!("mutation-{i}"),"expected_graph_revision":revision,"command":command});
        assert!(input.to_string().len() <= 4096);
        let t = Instant::now();
        let result = apply(&s, input).await?;
        let time = t.elapsed();
        assert_eq!(result["ok"], true, "{result}");
        revision += 1;
        assert_eq!(result["graph_revision"], revision);
        if i % 10 == 0 {
            dags.push(time);
        } else {
            edits.push(time);
        }
        peak = peak.max(usage::sample(pid)?.unwrap().resident_bytes);
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let checkpoint_before = usage::sample(std::process::id())?.unwrap();
    seed::checkpoint(&s);
    let checkpoint_after = usage::sample(std::process::id())?.unwrap();
    let after = usage::sample(pid)?.unwrap();
    let cpu_ms = usage::cpu_milliseconds(pid)
        .zip(cpu_before)
        .map(|(a, b)| a - b);
    let operations_after = get(&s, "/sessions/general/work-model-metrics").await?;
    let writes = after.write_chars.unwrap() - before.write_chars.unwrap()
        + checkpoint_after.write_chars.unwrap()
        - checkpoint_before.write_chars.unwrap();
    report_samples("metadata edit", &edits);
    report_samples("affected DAG edit", &dags);
    let edit_p95 = p95(edits);
    let dag_p95 = p95(dags);
    butler_e2e::assert_wall_clock_budget!(edit_p95, Duration::from_millis(100), "WM-13");
    butler_e2e::assert_wall_clock_budget!(dag_p95, Duration::from_millis(200), "WM-13");
    assert!(writes / 1000 <= 128 * 1024, "whole-process writes {writes}");
    assert!(
        peak - before.resident_bytes <= 32 * 1024 * 1024,
        "incremental RSS {}",
        peak - before.resident_bytes
    );
    let mut stale = reqwest::Url::parse("http://fixture/sessions/general/work-summary").unwrap();
    stale
        .query_pairs_mut()
        .append_pair("cursor", cold["next_cursor"].as_str().unwrap());
    let conflict = get(&s, stale.as_str().strip_prefix("http://fixture").unwrap()).await?;
    assert_eq!(conflict["error"]["code"], "cursor_revision_conflict");
    let latest = get(&s, "/sessions/general/work-summary").await?;
    check_summary(&latest, revision);
    summary_pages(&s, revision).await?;
    graph(&s, &plan, revision).await?;
    let events = latest["event_seq"].clone();
    s.restart().await?;
    let restarted = get(&s, "/sessions/general/work-summary").await?;
    assert_eq!(restarted, latest);
    eprintln!(
        "WM-13 Summary cold={cold_time:?} warm_p95={summary_p95:?}; Graph p95={graph_p95:?} all={full:?}; Spec p95={spec_p95:?}; edit={edit_p95:?} DAG={dag_p95:?}; writes={writes} average={} RSS_delta={}",
        writes / 1000,
        peak - before.resident_bytes
    );
    assert_eq!(restarted["event_seq"], events);
    eprintln!(
        "WM-13 CPU_ms={cpu_ms:?} peak_RSS={peak} storage_lane_operations={} SQL_statements={} process_rchar={} process_read_bytes={} process_write_bytes={}",
        operations_after["storage_operations"].as_u64().unwrap()
            - operations_before["storage_operations"].as_u64().unwrap(),
        operations_after["btcc_sql_statements"].as_u64().unwrap()
            - operations_before["btcc_sql_statements"].as_u64().unwrap(),
        after.read_chars.unwrap() - before.read_chars.unwrap(),
        after.read_bytes - before.read_bytes,
        after.write_bytes - before.write_bytes
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    instructions::run(&mut s).await?;
    idle(&s).await?;
    activation::run(&s).await?;
    s.finish().await
}

async fn concurrent_workers(s: &Scenario) -> Result<(), HarnessError> {
    let samples = futures_util::future::try_join_all((0..8).map(|i| async move {
        let t = Instant::now();
        let view = get(s, &format!("/sessions/worker-scale-{i}/work-summary")).await?;
        let elapsed = t.elapsed();
        assert_eq!(view["total"], 10_000);
        assert_eq!(view["counts"]["running"], 32);
        assert_eq!(view["counts"]["completed"], 9968);
        assert_eq!(view["tasks"].as_array().unwrap().len(), 50);
        assert_eq!(
            view["current_task"]["assignee_session_id"],
            format!("worker-scale-{i}")
        );
        assert_eq!(view["current_task"]["status"], "running");
        Ok::<_, HarnessError>(elapsed)
    }))
    .await?;
    report_samples("eight concurrent worker Summary reads", &samples);
    butler_e2e::assert_wall_clock_budget!(
        p95(samples),
        Duration::from_millis(100),
        "WM-13 parallel Summary"
    );
    Ok(())
}
fn check_summary(v: &Value, revision: u64) {
    assert_eq!(v["total"], 10_000);
    assert_eq!(v["counts"]["pending"], 10_000);
    assert_eq!(v["spec_count"], 10_000);
    assert_eq!(v["graph_revision"], revision);
    let tasks = v["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 50);
    assert!(
        tasks
            .windows(2)
            .all(|p| p[0]["rank"].as_i64().unwrap() < p[1]["rank"].as_i64().unwrap())
    );
    assert!(v["next_cursor"].is_string());
}
async fn graph(
    s: &Scenario,
    plan: &str,
    revision: u64,
) -> Result<(Duration, Duration), HarnessError> {
    let started = Instant::now();
    let mut cursor: Option<String> = None;
    let mut nodes = HashSet::new();
    let mut edges = HashSet::new();
    let mut samples = Vec::new();
    loop {
        let mut url =
            reqwest::Url::parse(&format!("http://fixture/plans/{plan}/task-graph")).unwrap();
        url.query_pairs_mut()
            .append_pair("revision", &revision.to_string());
        if let Some(c) = &cursor {
            url.query_pairs_mut().append_pair("cursor", c);
        }
        let t = Instant::now();
        let v = get(s, url.as_str().strip_prefix("http://fixture").unwrap()).await?;
        samples.push(t.elapsed());
        assert_eq!(v["total"], 10_000);
        assert_eq!(v["edge_total"], 30_000);
        assert_eq!(v["graph_revision"], revision);
        assert_eq!(v["tasks"].as_array().unwrap().len(), 500);
        for task in v["tasks"].as_array().unwrap() {
            assert!(nodes.insert(task["id"].as_str().unwrap().to_owned()));
            assert_eq!(task["status"], "pending");
            assert_eq!(task["criterion_ids"], json!(["AC"]));
        }
        for edge in v["edges"].as_array().unwrap() {
            assert!(edges.insert((
                edge["from"].as_str().unwrap().to_owned(),
                edge["to"].as_str().unwrap().to_owned()
            )));
        }
        cursor = v["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(nodes.len(), 10_000);
    assert_eq!(edges.len(), 30_000);
    assert!(
        edges
            .iter()
            .all(|(a, b)| nodes.contains(a) && nodes.contains(b))
    );
    report_samples("Graph warm", &samples[1..]);
    butler_e2e::assert_wall_clock_budget!(
        samples[0],
        Duration::from_millis(300),
        "WM-13 Graph cold"
    );
    Ok((p95(samples), started.elapsed()))
}

async fn summary_pages(s: &Scenario, revision: u64) -> Result<(), HarnessError> {
    let mut cursor: Option<String> = None;
    let mut ids = HashSet::new();
    let mut last_rank = -1;
    loop {
        let mut url = reqwest::Url::parse("http://fixture/sessions/general/work-summary").unwrap();
        if let Some(c) = &cursor {
            url.query_pairs_mut().append_pair("cursor", c);
        }
        let page = get(s, url.as_str().strip_prefix("http://fixture").unwrap()).await?;
        check_summary_page(&page, revision);
        for task in page["tasks"].as_array().unwrap() {
            assert!(ids.insert(task["id"].as_str().unwrap().to_owned()));
            let rank = task["rank"].as_i64().unwrap();
            assert!(rank > last_rank);
            last_rank = rank;
            assert_eq!(task["status"], "pending");
            assert_eq!(task["criterion_ids"], json!(["AC"]));
        }
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 10_000);
    Ok(())
}
fn check_summary_page(v: &Value, revision: u64) {
    assert_eq!(v["total"], 10_000);
    assert_eq!(v["counts"]["pending"], 10_000);
    assert_eq!(v["spec_count"], 10_000);
    assert_eq!(v["graph_revision"], revision);
    assert_eq!(v["tasks"].as_array().unwrap().len(), 50);
}

async fn idle(s: &Scenario) -> Result<(), HarnessError> {
    // Work-model metrics are memory-only; reading them cannot hide a polling query.
    let pid = s.agent.pid().unwrap();
    eprintln!("WM-13 idle pid={pid}");
    let before = get(s, "/sessions/general/work-model-metrics").await?;
    let mut usage_before = usage::sample(pid)?.unwrap();
    for window in 0..3 {
        let files = seed::managed_files(s)?;
        tokio::time::sleep(Duration::from_secs(60)).await;
        let before_metrics = usage::sample(pid)?.unwrap();
        let current = get(s, "/sessions/general/work-model-metrics").await?;
        assert_eq!(
            current, before,
            "Idle Work-model SQL activity in window {window}"
        );
        assert_eq!(
            seed::managed_files(s)?,
            files,
            "Idle managed file write in window {window}"
        );
        let usage_after = usage::sample(pid)?.unwrap();
        eprintln!(
            "WM-13 idle reads before metrics={} metrics query={}",
            before_metrics.read_chars.unwrap() - usage_before.read_chars.unwrap(),
            usage_after.read_chars.unwrap() - before_metrics.read_chars.unwrap()
        );
        eprintln!(
            "WM-13 idle window={window} storage_operations={} process_wchar={} reads={} RSS={}",
            current["storage_operations"],
            usage_after.write_chars.unwrap() - usage_before.write_chars.unwrap(),
            usage_after.read_chars.unwrap() - usage_before.read_chars.unwrap(),
            usage_after.resident_bytes
        );
        assert!(
            usage_after
                .footprint_bytes
                .unwrap_or(usage_after.resident_bytes)
                < 100_000_000,
            "PERF-IDLE memory: {usage_after:?}"
        );
        assert!(
            usage_after
                .read_chars
                .zip(usage_before.read_chars)
                .is_none_or(|(a, b)| a - b < 1_000_000)
                && usage_after.read_bytes - usage_before.read_bytes < 1_000_000,
            "PERF-IDLE reads: {usage_after:?}"
        );
        usage_before = usage_after;
    }
    Ok(())
}
