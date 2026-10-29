//! Same execution path for offline fake-upstream validation and owner live runs.
use super::{checks, db, fake, fixture, local};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Meta},
    config::{LiveProvider, ModelChoice},
    gateway::turn_state,
    provider::{Provider, delegation_eval::Evaluation},
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

pub(super) async fn suite(live: Option<LiveProvider>) -> Result<(), HarnessError> {
    let mode =
        std::env::var("BUTLER_E2E_DELEGATION_MODE").unwrap_or_else(|_| "first-decision".into());
    let first = mode == "first-decision";
    assert!(first || mode == "steward");
    let data: Value = serde_json::from_str(if first {
        include_str!("../../../../fixtures/delegation-eval/first-decision-cases.json")
    } else {
        include_str!("../../../../fixtures/delegation-eval/steward-cases.json")
    })?;
    let ids = std::env::var("BUTLER_E2E_DELEGATION_CASES").unwrap_or_default();
    let cases: Vec<_> = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| ids.is_empty() || ids.split(',').any(|id| c["id"] == id))
        .collect();
    assert!(!cases.is_empty(), "no cases selected");
    if !ids.is_empty() {
        assert_eq!(
            cases.len(),
            ids.split(',').count(),
            "unknown or duplicate case id"
        );
    }
    for case in cases {
        if let Err(error) = one(case, first, live.clone()).await {
            let mut row = json!({"mode":mode,"model":live.as_ref().map(|p|p.choice.label())
                .unwrap_or_else(||"openai/gpt-6-luna".into()),"variant":variant(),
                "repeat":number("BUTLER_E2E_DELEGATION_REPEAT",1),"case":case["id"],
                "label":case["label"],"samples":[],"db":{},"wall_ms":0,"timed_out":false,
                "round_limit":false,"error":error.to_string(),"offline":live.is_none()});
            diagnostics(&mut row);
            write(row).await?;
            if live.is_none() {
                return Err(error);
            }
        }
    }
    Ok(())
}
pub(super) async fn one(
    case: &Value,
    first: bool,
    live: Option<LiveProvider>,
) -> Result<(), HarnessError> {
    let fake = if live.is_none() {
        Some(
            fake::Upstream::start(first, case)
                .await
                .map_err(|_| stage("fake_upstream_start"))?,
        )
    } else {
        None
    };
    let upstream = local::upstream(live.as_ref(), fake.as_ref().map(|f| f.base.as_str()))
        .map_err(|_| stage("upstream_configuration"))?;
    let max = number("BUTLER_E2E_DELEGATION_MAX_ROUNDS", 80);
    let (proxy, eval) = Provider::delegation_evaluation(upstream, !first, max)
        .await
        .map_err(|_| stage("proxy_start"))?;
    let model = live
        .as_ref()
        .map(|p| p.choice.clone())
        .unwrap_or_else(|| ModelChoice::parse("openai/gpt-6-luna").unwrap());
    let setup = setup(case, live, &model, &proxy.base_url).map_err(|_| stage("sandbox_setup"))?;
    let (mut s, chat) = prepare(setup, case, first, &eval, &proxy.base_url).await?;
    *eval.local_text.lock().unwrap() = "Evaluation turn finished.".into();
    eval.armed.store(first, Ordering::SeqCst);
    if !first {
        *eval.delegation.lock().unwrap() = local::parent_script(case, &variant()).into();
    }
    let begin = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(number("BUTLER_E2E_DELEGATION_SECONDS", 900) as u64),
        execute(&s, &chat, case, &eval, first),
    )
    .await;
    let timed_out = result.is_err();
    let error = result.ok().and_then(Result::err).map(|e| e.to_string());
    // Stop before reading the case database; every case owns its child process.
    drop(s.agent);
    let graph = snapshot(&s.sandbox.data, &s.sandbox.workspace, case, first)
        .await
        .map_err(|_| stage("database_snapshot"))?;
    let samples = eval.snapshot();
    let local_calls = eval.local_calls.lock().unwrap().clone();
    let artifacts = retain(&s.sandbox.workspace, case)
        .await
        .map_err(|_| stage("retain_workspace"))?;
    let mut row = json!({"mode":if first {"first-decision"} else {"steward"},"model":model.label(),
        "variant":variant(),
        "repeat":number("BUTLER_E2E_DELEGATION_REPEAT",1),"case":case["id"],"label":case["label"],
        "expected_mode":case["expected_mode"],"checks":case["checks"],"samples":samples,"db":graph,
        "artifacts":artifacts,"wall_ms":begin.elapsed().as_millis(),"timed_out":timed_out,"error":error,
        "round_limit":eval.limited.load(Ordering::SeqCst),"offline":fake.is_some(),
        "terminal_result":!timed_out && error.is_none() && !eval.limited.load(Ordering::SeqCst),
        "upstream_rounds":eval.upstream_rounds(),"local_answers":eval.local_answers.load(Ordering::SeqCst),"local_calls":local_calls});
    diagnostics(&mut row);
    if let Some(fake) = &fake {
        fake.verify(row["samples"].as_array().unwrap());
        checks::verify(case, first, &row, &s.sandbox.workspace);
    }
    write(row).await?;
    s.sandbox.mark_success();
    drop(proxy); // replay state; never serializes transient recorder exchanges
    Ok(())
}
async fn prepare(
    setup: Setup,
    case: &Value,
    first: bool,
    eval: &Evaluation,
    proxy: &str,
) -> Result<(Scenario, String), HarnessError> {
    let root = setup.sandbox.workspace.clone();
    let c = case.clone();
    tokio::task::spawn_blocking(move || fixture::files(&root, &c, first))
        .await
        .map_err(|_| stage("fixture_task"))?
        .map_err(|_| stage("fixture_files"))?;
    let s = setup.start().await.map_err(|_| stage("agent_start"))?;
    fixture::register_model(&s, proxy)
        .await
        .map_err(|_| stage("register_model"))?;
    if !first {
        fixture::workers(&s)
            .await
            .map_err(|_| stage("worker_setup"))?;
    }
    let chat = fixture::chat(&s).await.map_err(|_| stage("chat_setup"))?;
    for prior in case["history"].as_array().into_iter().flatten() {
        *eval.local_text.lock().unwrap() = prior["butler"].as_str().unwrap().into();
        let (_, turn) = s
            .turn(&chat, prior["user"].as_str().unwrap())
            .await
            .map_err(|_| stage("history_turn_wait"))?;
        if turn_state(&turn) != "delivered" {
            return Err(stage("history_turn_not_delivered"));
        }
    }
    Ok((s, chat))
}
fn variant() -> String {
    std::env::var("BUTLER_E2E_DELEGATION_VARIANT").unwrap_or_else(|_| "new".into())
}
fn setup(
    case: &Value,
    live: Option<LiveProvider>,
    model: &ModelChoice,
    proxy: &str,
) -> Result<Setup, HarnessError> {
    let setup = Setup::new(&format!("DELEGATION-{}", case["id"].as_str().unwrap()))?;
    Ok(if let Some(provider) = live {
        local::live_setup(setup, provider, proxy)
    } else {
        setup
            .stub_cassette(Cassette {
                scenario: "eval-local".into(),
                meta: Meta {
                    provider: "openai-subscription".into(),
                    model: model.model.clone(),
                    ..Meta::default()
                },
                exchanges: vec![],
            })
            .env("BUTLER_CHATGPT_API_BASE_URL", format!("{proxy}/v1"))
    })
}
async fn snapshot(
    data: &std::path::Path,
    workspace: &std::path::Path,
    case: &Value,
    first: bool,
) -> Result<Value, HarnessError> {
    let path = data.join("agent-runtime/btcc.sqlite");
    let (case, workspace) = (case.clone(), workspace.to_owned());
    tokio::task::spawn_blocking(move || {
        let mut graph = db::snapshot(&path, &case, first)?;
        if !first {
            graph["checks_look_met"] = checks::inspect(&workspace, &case, &graph)?;
        }
        Ok(graph)
    })
    .await
    .unwrap()
}

pub(super) fn diagnostics(row: &mut Value) {
    let samples = row["samples"].as_array().unwrap();
    let mismatch = samples.iter().any(|s| s["extraction_mismatch"] == true);
    let reason = if row["timed_out"] == true {
        Some("timeout")
    } else if row["error"].is_string() {
        Some("harness_error")
    } else if samples.is_empty() {
        Some("no_upstream_samples")
    } else if samples.iter().any(|s| s["http_status"] != 200) {
        Some("upstream_http_error")
    } else if samples.iter().any(|s| s["complete"] != true) {
        Some("missing_upstream_terminal_result")
    } else if mismatch {
        Some("extraction_mismatch")
    } else if row["terminal_result"] == false && row["round_limit"] != true {
        Some("missing_agent_terminal_result")
    } else {
        None
    };
    row["first_output_item"] = samples
        .first()
        .map(|s| s["first_output_item"].clone())
        .unwrap_or(Value::Null);
    row["harness_error_reason"] = if reason == Some("harness_error") {
        row["error"].clone()
    } else {
        Value::Null
    };
    row["extraction_mismatch"] = json!(mismatch);
    row["invalid_reason"] = json!(reason);
    row["outcome"] = json!(if reason.is_some() {
        "invalid"
    } else if row["round_limit"] == true {
        "limit_hit"
    } else {
        "completed"
    });
}

async fn execute(
    s: &Scenario,
    chat: &str,
    case: &Value,
    eval: &Arc<Evaluation>,
    first: bool,
) -> Result<(), HarnessError> {
    if first {
        let (_, turn) = s
            .turn(chat, case["request"].as_str().unwrap())
            .await
            .map_err(|_| stage("evaluation_turn_wait"))?;
        if turn_state(&turn) != "delivered" {
            return Err(stage(match turn_state(&turn) {
                "failed" => "evaluation_turn_failed",
                "runtime_fault" => "evaluation_turn_runtime_fault",
                "cancelled" => "evaluation_turn_cancelled",
                _ => "evaluation_turn_not_delivered",
            }));
        }
        return Ok(());
    }
    s.gw.say(chat, case["request"].as_str().unwrap())
        .await
        .map_err(|_| stage("evaluation_admission"))?;
    loop {
        if eval.limited.load(Ordering::SeqCst) {
            // A concurrent Worker request may still be collecting its last sample.
            while eval.inflight.load(Ordering::SeqCst) > 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            return Ok(());
        }
        let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
        let settled = tokio::task::spawn_blocking(move || db::settled(&path))
            .await
            .map_err(|_| stage("settled_task"))?
            .map_err(|_| stage("settled_database"))?;
        if settled {
            let turns =
                s.gw.turns(chat)
                    .await
                    .map_err(|_| stage("evaluation_turns"))?;
            if turns.last().is_some_and(|turn| {
                butler_e2e::e2e::gateway::TERMINAL.contains(&turn_state(turn))
                    && turn["execution_controls"]["subsession_result"].is_object()
            }) {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
fn number(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .map(|v| v.parse::<usize>().expect("positive integer"))
        .inspect(|n| assert!(*n > 0))
        .unwrap_or(default)
}
async fn write(row: Value) -> Result<(), HarnessError> {
    tokio::task::spawn_blocking(move || {
        let path = std::env::var("BUTLER_E2E_DELEGATION_OUT").expect("output path");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(file, "{row}").map_err(HarnessError::from)
    })
    .await
    .unwrap()
}

async fn retain(workspace: &std::path::Path, case: &Value) -> Result<String, HarnessError> {
    let root = workspace.to_owned();
    let name = format!(
        "{}-{}-{}",
        std::env::var("BUTLER_E2E_DELEGATION_VARIANT").unwrap_or_else(|_| "new".into()),
        number("BUTLER_E2E_DELEGATION_REPEAT", 1),
        case["id"].as_str().unwrap()
    );
    let out = std::path::PathBuf::from(std::env::var("BUTLER_E2E_DELEGATION_OUT").unwrap());
    let dest = out.parent().unwrap().join("workspaces").join(name);
    tokio::task::spawn_blocking(move || {
        butler_e2e::e2e::sandbox::copy_tree(&root, &dest)?;
        Ok(dest.display().to_string())
    })
    .await
    .unwrap()
}

fn stage(reason: &str) -> HarnessError {
    HarnessError(reason.into())
}
