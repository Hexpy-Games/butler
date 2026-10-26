//! Same execution path for offline fake-upstream validation and owner live runs.
use super::{checks, db, fake, fixture};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Meta},
    config::{LiveProvider, ModelChoice, base_path},
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
        one(case, first, live.clone()).await?;
    }
    Ok(())
}
async fn one(case: &Value, first: bool, live: Option<LiveProvider>) -> Result<(), HarnessError> {
    let fake = if live.is_none() {
        Some(fake::Upstream::start(first, case).await?)
    } else {
        None
    };
    let upstream = live
        .as_ref()
        .and_then(|p| {
            p.base_url
                .clone()
                .or_else(|| p.upstream_default().map(str::to_owned))
        })
        .unwrap_or_else(|| fake.as_ref().unwrap().base.clone());
    let max = number("BUTLER_E2E_DELEGATION_MAX_ROUNDS", 80);
    let (proxy, eval) = Provider::delegation_evaluation(upstream, !first, max).await?;
    let model = live
        .as_ref()
        .map(|p| p.choice.clone())
        .unwrap_or_else(|| ModelChoice::parse("openai/gpt-6-luna").unwrap());
    let mut setup = Setup::new(&format!("DELEGATION-{}", case["id"].as_str().unwrap()))?;
    setup = if let Some(mut provider) = live {
        provider.base_url = Some(format!(
            "{}{}",
            proxy.base_url,
            base_path(&provider.provider)
        ));
        let anthropic = provider.provider == "anthropic";
        let mut configured = setup.live(provider);
        if anthropic {
            // This loopback recorder forwards unchanged bytes to the official endpoint.
            configured = configured.env(
                "BUTLER_ANTHROPIC_CACHE_VERIFIED_ENDPOINT",
                format!("{}/messages", proxy.base_url),
            );
        }
        configured
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
            .env(
                "BUTLER_CHATGPT_API_BASE_URL",
                format!("{}/v1", proxy.base_url),
            )
    };
    let root = setup.sandbox.workspace.clone();
    let c = case.clone();
    tokio::task::spawn_blocking(move || fixture::files(&root, &c, first))
        .await
        .unwrap()?;
    let mut s = setup.start().await?;
    if !first {
        fixture::workers(&s).await?;
    }
    let chat = fixture::chat(&s).await?;
    for prior in case["history"].as_array().into_iter().flatten() {
        *eval.local_text.lock().unwrap() = prior["butler"].as_str().unwrap().into();
        let (_, turn) = s.turn(&chat, prior["user"].as_str().unwrap()).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
    }
    *eval.local_text.lock().unwrap() = "Evaluation turn finished.".into();
    eval.armed.store(first, Ordering::SeqCst);
    if !first {
        *eval.delegation.lock().unwrap() =
            Some(butler_e2e::e2e::provider::delegation_eval::wire::call(
                "delegate_to_steward",
                &json!({"request":case["request"],"checks":case["checks"]}),
            ));
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
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let c = case.clone();
    let workspace = s.sandbox.workspace.clone();
    let graph = tokio::task::spawn_blocking(move || {
        let mut graph = db::snapshot(&path, &c, first)?;
        if !first {
            graph["checks_look_met"] = checks::inspect(&workspace, &c, &graph)?;
        }
        Ok::<_, HarnessError>(graph)
    })
    .await
    .unwrap()?;
    let samples = eval.snapshot();
    if let Some(fake) = &fake {
        fake.verify(&samples);
        for prior in case["history"].as_array().into_iter().flatten() {
            assert!(
                samples[0]["request"]
                    .to_string()
                    .contains(prior["butler"].as_str().unwrap()),
                "seeded history is missing"
            );
        }
        assert!(
            samples[0]["instruction_tool_tokens_o200k_estimate"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(!timed_out, "offline evaluation timed out: {graph}");
        assert!(error.is_none(), "{error:?}");
        if first {
            assert_eq!(samples.len(), 1);
            if case["label"] == "delegate" {
                assert_eq!(samples[0]["calls"][0]["name"], "delegate_to_steward");
            } else {
                assert_eq!(samples[0]["calls"], json!([]));
            }
            assert_eq!(
                graph["executed_tools"],
                json!([]),
                "evaluated tools executed"
            );
        } else {
            assert_eq!(graph["plan_gate_refusals"], 1, "{graph}");
            assert_eq!(graph["plan_before_first_mutation"], false, "{graph}");
            assert_eq!(graph["plan_review_accepted"], true, "{graph}");
            assert_eq!(graph["workers_when_expected"], true, "{graph}");
            assert_eq!(graph["disposition_recorded"], true, "{graph}");
            assert!(!s.sandbox.workspace.join("premature.txt").exists());
        }
    }
    let artifacts = retain(&s.sandbox.workspace, case).await?;
    let row = json!({"mode":if first {"first-decision"} else {"steward"},"model":model.label(),
        "variant":std::env::var("BUTLER_E2E_DELEGATION_VARIANT").unwrap_or_else(|_|"new".into()),
        "repeat":number("BUTLER_E2E_DELEGATION_REPEAT",1),"case":case["id"],"label":case["label"],
        "expected_mode":case["expected_mode"],"checks":case["checks"],"samples":samples,"db":graph,
        "artifacts":artifacts,"wall_ms":begin.elapsed().as_millis(),"timed_out":timed_out,"error":error,
        "round_limit":eval.limited.load(Ordering::SeqCst),"offline":fake.is_some()});
    write(row).await?;
    s.sandbox.mark_success();
    drop(proxy); // replay state; never serializes transient recorder exchanges
    Ok(())
}
async fn execute(
    s: &Scenario,
    chat: &str,
    case: &Value,
    eval: &Arc<Evaluation>,
    first: bool,
) -> Result<(), HarnessError> {
    if first {
        let (_, turn) = s.turn(chat, case["request"].as_str().unwrap()).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        return Ok(());
    }
    s.gw.say(chat, case["request"].as_str().unwrap()).await?;
    loop {
        if eval.limited.load(Ordering::SeqCst) {
            return Ok(());
        }
        let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
        let settled = tokio::task::spawn_blocking(move || db::settled(&path))
            .await
            .unwrap()?;
        if settled {
            let turns = s.gw.turns(chat).await?;
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
