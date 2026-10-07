//! Explicitly authorized live measurement; one guarded run covers ON then OFF.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
#[path = "proxy.rs"]
mod proxy;
use butler_e2e::e2e::{HarnessError, live, scenario::Setup};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[tokio::test]
#[ignore = "authorized Luna live measurement only"]
async fn worker_wait_keepalive_live_on_then_off() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider = live::gate("KEEPALIVE-LIVE")?.expect("live credentials required");
    assert_eq!(provider.choice.model, "openai/gpt-6-luna");
    let guard = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for mode in ["on", "off"] {
        measure(mode, provider.clone(), guard.clone()).await?;
    }
    eprintln!(
        "KEEPALIVE-LIVE total_calls={}",
        guard.load(std::sync::atomic::Ordering::SeqCst)
    );
    Ok(())
}
async fn measure(
    mode: &str,
    provider: butler_e2e::e2e::config::LiveProvider,
    guard: Arc<std::sync::atomic::AtomicUsize>,
) -> Result<(), HarnessError> {
    let (url, observations, server) = proxy::start(guard).await?;
    let s = Setup::new(&format!("KEEPALIVE-LIVE-{mode}"))?
        .live(provider)
        .env("BUTLER_CODEX_BASE_URL", &url)
        .env("BUTLER_PROMPT_CACHE_KEEPALIVE", mode)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let prompt = "Create and approve a minimal work plan in steward execution mode. Delegate exactly one task to a steward: use run_command to run exactly `sleep 720; printf 'WAIT_DONE\\n'` with timeout_ms 780000, summary 'Wait measurement', state_effect 'read_only', then mark the action complete and report WAIT_DONE. No other tools or research are needed for the task. The parent must delegate and wait; do not run sleep yourself. After receiving the delegated result, review it and reply WAIT_DONE. This is an authorized cache measurement.";
    let accepted = s.gw.say("general", prompt).await?;
    butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    wait_resume(mode, &db, &observations).await?;
    let view =
        s.gw.get("/session-view?session_id=general")
            .await?
            .data()
            .clone();
    let turn = view["latest_turn"]["id"].as_str().expect("resume turn");
    s.gw.wait_terminal("general", turn, Duration::from_secs(120))
        .await?;
    report(mode, &s, &db, &observations)?;
    s.finish().await?;
    server.abort();
    Ok(())
}
async fn wait_resume(
    mode: &str,
    db: &rusqlite::Connection,
    observations: &proxy::Observations,
) -> Result<(), HarnessError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(1100);
    let mut announced = false;
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "live wait did not complete"
        );
        let waiting: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE suspension_reason='waiting_for_worker')",
            [],
            |r| r.get(0),
        )?;
        if waiting && !announced {
            eprintln!("KEEPALIVE-LIVE {mode}: parent waiting for delegated sleep");
            announced = true;
        }
        let resumed = observations.lock().unwrap().iter().any(|o| o.resume);
        if resumed {
            break;
        }
        if observations.lock().unwrap().iter().any(|o| o.failed) {
            return Err(HarnessError(
                "live provider request failed; no retry measurement".into(),
            ));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(announced, "parent never entered WaitingForWorker");
    Ok(())
}
fn report(
    mode: &str,
    s: &butler_e2e::e2e::scenario::Scenario,
    db: &rusqlite::Connection,
    observations: &proxy::Observations,
) -> Result<(), HarnessError> {
    let completed: String = db.query_row(
        "SELECT created_at FROM btcc_steward_results ORDER BY created_at DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let completed_ms = chrono::DateTime::parse_from_rfc3339(&completed)
        .map_err(|_| HarnessError("invalid completion timestamp".into()))?
        .timestamp_millis();
    let rows = observations.lock().unwrap().clone();
    let resume = rows.iter().find(|r| r.resume).expect("resume observation");
    let delegated: Vec<_> = rows.iter().filter(|r| r.delegated).collect();
    let gap = delegated
        .windows(2)
        .map(|pair| pair[1].started_ms - pair[0].started_ms)
        .max()
        .unwrap_or(0);
    assert!(
        gap >= 710_000,
        "worker did not execute the twelve-minute wait: {gap} ms"
    );
    let success: bool = db.query_row("SELECT status='success' AND summary LIKE '%WAIT_DONE%' FROM btcc_steward_results ORDER BY created_at DESC LIMIT 1", [], |r| r.get(0))?;
    assert!(success, "worker did not report successful WAIT_DONE");
    let metrics: Vec<Value> =
        std::fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?;
    let resumed = metrics
        .iter()
        .find(|r| {
            matches!(
                r["prefixDiagnostics"]["trigger"].as_str(),
                Some("steward-result" | "worker-result")
            )
        })
        .expect("resume usage");
    let pings: Vec<_> = metrics
        .iter()
        .filter(|r| r["phase"] == "keepalive")
        .collect();
    let sum = |key: &str| {
        pings
            .iter()
            .map(|r| r[key].as_f64().unwrap_or(0.0))
            .sum::<f64>()
    };
    let input = resumed["promptTokens"].as_f64().unwrap();
    let cached = resumed["cachedTokens"].as_f64().unwrap_or(0.0);
    let report = json!({"mode":mode,"resume_input":input,"resume_cached":cached,
        "hit_percent":100.0*cached/input,"pings":pings.len(),"ping_input":sum("promptTokens"),
        "ping_cached":sum("cachedTokens"),"ping_output":sum("totalTokens")-sum("promptTokens"),
        "completion_to_resume_ms":resume.started_ms-completed_ms,"worker_gap_ms":gap,"calls":rows.len()});
    eprintln!("KEEPALIVE-LIVE {report}");
    if let Ok(path) = std::env::var("BUTLER_KEEPALIVE_LIVE_REPORT") {
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?,
            "{report}"
        )?;
    }
    Ok(())
}
