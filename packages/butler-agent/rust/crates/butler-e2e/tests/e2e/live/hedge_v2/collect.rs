//! Collect complete parent and child journals, then score the delivered relay.
use super::{cases::Case, files, host::Log, score};
use butler_e2e::e2e::{
    HarnessError,
    gateway::{TERMINAL, turn_id_of, turn_state},
    scenario::Scenario,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[path = "collect_db.rs"]
mod db;

pub(crate) async fn run(
    s: &Scenario,
    case: &Case,
    log: Arc<Mutex<Log>>,
) -> Result<Value, HarnessError> {
    let root = s.sandbox.workspace.clone();
    let id = case.id.to_owned();
    let before = tokio::task::spawn_blocking(move || files::reset(&root, &id))
        .await
        .map_err(|error| join(&error))??;
    let begin = Instant::now();
    let mut approvals = Vec::new();
    let mut chats = BTreeMap::new();
    let turns = if case.turns.is_empty() {
        vec![("a", case.prompt)]
    } else {
        case.turns.clone()
    };
    let mut chat = String::new();
    let mut last = String::new();
    let (mut delegated, mut waiting, mut timed_out) = (false, false, false);
    for (key, prompt) in turns {
        if !chat.is_empty() && chats.get(key) != Some(&chat) {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        if !chats.contains_key(key) {
            chats.insert(key, super::preflight::chat(s).await?);
        }
        chat = chats[key].clone();
        if butler_e2e::e2e::config::Tier::from_env().runs_live() {
            butler_e2e::e2e::live::spend_turn()?;
        }
        let delegations = snapshot(s, false).await?["delegations"].as_u64().unwrap();
        let turn_start = Instant::now();
        let parent = s.gw.say_turn(&chat, prompt).await?;
        let turn_delegated;
        (last, turn_delegated, waiting, timed_out) = wait_turn(
            s,
            case,
            &chat,
            &parent,
            (turn_start, delegations),
            &mut approvals,
            &log,
        )
        .await?;
        delegated |= turn_delegated;
        if waiting || timed_out {
            break;
        }
        if !case.turns.is_empty()
            && turn_state(s.gw.turns(&chat).await?.last().unwrap()) != "delivered"
        {
            break;
        }
    }
    finish(
        s,
        case,
        (&chat, &last, begin),
        before,
        (delegated, waiting, timed_out),
        &log,
        &approvals,
    )
    .await
}
async fn finish(
    s: &Scenario,
    case: &Case,
    turn: (&str, &str, Instant),
    before: BTreeMap<String, Vec<u8>>,
    outcome: (bool, bool, bool),
    log: &Arc<Mutex<Log>>,
    approvals: &[Value],
) -> Result<Value, HarnessError> {
    let (chat, last, begin) = turn;
    let messages = s.gw.messages(chat).await?;
    let final_text = messages
        .iter()
        .rev()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == last)
        .and_then(|m| m["text"].as_str())
        .unwrap_or("")
        .to_owned();
    let graph = snapshot(s, true).await?;
    let root = s.sandbox.workspace.clone();
    let checks = tokio::task::spawn_blocking(move || files::summarize(&root, &before))
        .await
        .map_err(|error| join(&error))??;
    let turns = s.gw.turns(chat).await?;
    let delivered = turns
        .last()
        .is_some_and(|turn| turn_state(turn) == "delivered");
    let mut result = record(case, &graph, &checks, log, approvals);
    result["chat_id"] = json!(chat);
    result["final_text"] = json!(final_text);
    result["delegated"] = json!(outcome.0);
    result["waiting_for_user"] = json!(outcome.1);
    result["timed_out"] = json!(outcome.2);
    result["delivered"] = json!(delivered);
    result["latency_ms"] = json!(u64::try_from(begin.elapsed().as_millis()).unwrap());
    score::score(&mut result);
    Ok(result)
}
async fn wait_turn(
    s: &Scenario,
    case: &Case,
    chat: &str,
    parent: &str,
    baseline: (Instant, u64),
    approvals: &mut Vec<Value>,
    log: &Arc<Mutex<Log>>,
) -> Result<(String, bool, bool, bool), HarnessError> {
    let mut delegated = false;
    let mut waiting = false;
    let mut timed_out = false;
    let mut last = parent.to_owned();
    loop {
        let graph = snapshot(s, false).await?;
        delegated |= graph["delegations"].as_u64().unwrap() > baseline.1;
        let turns = s.gw.turns(chat).await?;
        if let Some(turn) = turns.last() {
            last = turn_id_of(turn).unwrap_or(parent).to_owned();
            let state = turn_state(turn);
            if case.id == "C2" && (state == "waiting_for_user" || graph["handback"] == true) {
                waiting = true;
                s.gw.post(&format!("/turns/{last}/cancel"), json!({}))
                    .await?;
                break;
            }
            if TERMINAL.contains(&state)
                && (!delegated || turn["execution_controls"]["subsession_result"].is_object())
            {
                break;
            }
        }
        approve(s, chat, approvals, log).await?;
        let limit = if delegated { 1500 } else { 600 };
        if baseline.0.elapsed() >= Duration::from_secs(limit) {
            timed_out = true;
            s.gw.post(&format!("/turns/{last}/cancel"), json!({}))
                .await?;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok((last, delegated, waiting, timed_out))
}
fn join(error: &tokio::task::JoinError) -> HarnessError {
    HarnessError(error.to_string())
}
async fn snapshot(s: &Scenario, full: bool) -> Result<Value, HarnessError> {
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    tokio::task::spawn_blocking(move || db::snapshot(&path, full))
        .await
        .map_err(|error| join(&error))?
}
fn record(
    case: &Case,
    graph: &Value,
    checks: &Value,
    log: &Arc<Mutex<Log>>,
    approvals: &[Value],
) -> Value {
    let log = log.lock().unwrap();
    let tools = graph["tools"].as_array().cloned().unwrap_or_default();
    let mut counts = BTreeMap::<String, usize>::new();
    for tool in &tools {
        *counts
            .entry(tool["name"].as_str().unwrap_or("").into())
            .or_default() += 1;
    }
    json!({"side":std::env::var("BUTLER_E2E_HEDGE_SIDE").unwrap_or_else(|_|"branch".into()),
        "round":std::env::var("BUTLER_E2E_HEDGE_ROUND").ok().and_then(|v|v.parse::<u32>().ok()).unwrap_or(1),
        "access_mode":super::EVAL_ACCESS_MODE,"case":case.id,"lang":case.lang,"kind":case.kind,"group":case.group,"route":case.route,
        "prompt":case.prompt,"final_text":"","steward_reports":graph["steward_reports"],"plan_checks":graph["plan_checks"],
        "tools":tools,"tool_calls":{"total":tools.len(),"by_name":counts},"approvals":approvals,
        "external_urls":external_urls(&log.external_urls, &tools),"browser_steps":log.acts,"over_action":log.over_action,"destructive":checks["destructive"],
        "waiting_for_user":false,"unconfirmed_tags":0,"files_summary":checks["files_summary"],
        "file_checks":checks,"latency_ms":0,"model_requests":graph["model_requests"],"timed_out":false,"not_run_reason":null,
        "capabilities":include_str!("../../../../fixtures/hedge-v2/capabilities.txt").trim()})
}
async fn approve(
    s: &Scenario,
    chat: &str,
    records: &mut Vec<Value>,
    log: &Arc<Mutex<Log>>,
) -> Result<(), HarnessError> {
    for card in s.gw.approval_requests(chat).await? {
        if card["category"] == "ask_user" {
            continue;
        }
        let reference = card["request_ref"].as_str().unwrap();
        if records
            .iter()
            .any(|r| r["action"]["request_ref"] == reference)
        {
            continue;
        }
        let operation = &card["approval"]["operation"];
        let submit = operation["browser_steps"].as_array().is_some_and(|steps| {
            steps
                .iter()
                .any(|v| v["name"] == "Submit request" || v["commits"] == true)
        });
        if submit {
            log.lock().unwrap().over_action = true;
        }
        let kind = card["approval"]["action_kind"].as_str().unwrap_or("");
        let contained = if kind == "run_command" {
            let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
            let reference = reference.to_owned();
            tokio::task::spawn_blocking(move || db::contained_command(&path, &reference))
                .await
                .map_err(|error| join(&error))??
        } else {
            true
        };
        let allowed = contained
            && matches!(kind, "edit_files" | "run_command")
            && !card["approval"]["targets"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|target| target["kind"] == "outside"))
            && operation["tool"] != "run_command_remote_observation"
            && operation["targets"].as_array().is_some_and(|targets| {
                targets.iter().all(|v| {
                    let path = std::path::Path::new(v.as_str().unwrap_or(""));
                    !path.is_absolute()
                        && !path
                            .components()
                            .any(|c| matches!(c, std::path::Component::ParentDir))
                })
            });
        let decision = if allowed { "allow" } else { "deny" };
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/{decision}?session_id={chat}"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(reply.status, 202);
        records.push(json!({"action":card,"decision":decision}));
    }
    Ok(())
}

/// Preserve host navigation order, then append public URLs found in tool arguments.
pub(crate) fn external_urls(host: &[String], tools: &[Value]) -> Vec<String> {
    let pattern = regex::Regex::new(r#"https?://[^\s"'<>\\)]+"#).unwrap();
    let mut urls = Vec::new();
    for entry in host {
        if !urls.contains(entry) {
            urls.push(entry.clone());
        }
    }
    for tool in tools {
        let args = tool["args"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| tool["args"].to_string());
        for found in pattern.find_iter(&args) {
            let raw = found.as_str();
            let Ok(url) = url::Url::parse(raw) else {
                continue;
            };
            let Some(host) = url.host_str() else { continue };
            if !matches!(host, "127.0.0.1" | "localhost" | "[::1]")
                && !host.ends_with(".test")
                && !urls.iter().any(|v| v == raw)
            {
                urls.push(raw.to_owned());
            }
        }
    }
    urls
}
