//! Cache maintenance exercises real delegation, queue arrival and provider wire.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
#[path = "worker_wait_keepalive/live.rs"]
mod live;
use super::delegate_followup::stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

#[tokio::test]
async fn worker_wait_keepalive_stops_on_result_and_preserves_resume() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("result").await
}
#[tokio::test]
async fn worker_wait_keepalive_cap() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("cap").await
}
#[tokio::test]
async fn worker_wait_keepalive_cancel() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("cancel").await
}
#[tokio::test]
async fn worker_wait_keepalive_failure_is_not_retried() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("failure").await
}
#[tokio::test]
async fn worker_wait_keepalive_off() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("off").await
}
#[tokio::test]
async fn worker_wait_keepalive_inflight_does_not_delay_resume() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("inflight").await
}

#[tokio::test]
async fn worker_wait_keepalive_new_input_stops_wait() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("input").await
}

#[tokio::test]
async fn worker_wait_keepalive_api_key_prefix() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("api").await
}
#[tokio::test]
async fn worker_wait_keepalive_24h_retention() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("retention").await
}

#[tokio::test]
async fn worker_wait_keepalive_archive() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("archive").await
}
#[tokio::test]
async fn worker_wait_keepalive_delete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("delete").await
}
#[tokio::test]
async fn worker_wait_keepalive_cap_floor() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise("capfloor").await
}

async fn exercise(mode: &str) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start(true).await?;
    script.fail_ping.store(mode == "failure", Ordering::SeqCst);
    script.hold_ping.store(mode == "inflight", Ordering::SeqCst);
    let api = matches!(mode, "api" | "retention");
    let mut setup = Setup::new(&format!("KEEPALIVE-{mode}"))?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url)
        .env(
            "BUTLER_PROMPT_CACHE_KEEPALIVE",
            if mode == "off" { "No" } else { "on" },
        )
        .env("BUTLER_PROMPT_CACHE_KEEPALIVE_INTERVAL_SECONDS", "1")
        .env(
            "BUTLER_PROMPT_CACHE_KEEPALIVE_CAP_SECONDS",
            if mode == "cap" {
                "45"
            } else if mode == "capfloor" {
                "1"
            } else {
                "120"
            },
        );
    if api {
        setup = setup
            .without_credential()
            .env("OPENAI_API_KEY", "stub-api-key")
            .env("OPENAI_BASE_URL", &url)
            .env("BUTLER_OPENAI_PROMPT_CACHE_RETENTION", "in_memory");
    }
    if mode == "retention" {
        setup = setup.env("BUTLER_OPENAI_PROMPT_CACHE_RETENTION", "24h");
    }
    let s = setup.start().await?;
    if api {
        register_api_route(&s).await?;
    }
    let session = if matches!(mode, "archive" | "delete") {
        let reply =
            s.gw.post(
                "/sessions",
                json!({"kind":"chat","title":"Keepalive lifecycle"}),
            )
            .await?;
        reply.data()["session"]["id"].as_str().unwrap().to_owned()
    } else {
        "general".into()
    };
    let view_url = format!("/session-view?session_id={session}");
    let (turn, outcome) = s.turn(&session, stub::OWNER).await?;
    assert_eq!(outcome["state"], "delivered", "{outcome}");
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let suspension: String = db.query_row(
        "SELECT suspension_reason FROM btcc_turns WHERE turn_id=?1",
        [&turn],
        |row| row.get(0),
    )?;
    assert_eq!(suspension, "waiting_for_worker");
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    wait_progress_publication(&db).await?;
    let baseline = s.gw.messages(&session).await?;
    assert!(baseline.iter().all(|m| m["text"] != "OK"));
    let transcripts = transcript_sizes(&s)?;
    assert!(
        !transcripts.is_empty(),
        "delegation must create a transcript"
    );
    let progress: i64 = db.query_row("SELECT COUNT(*) FROM btcc_progress_events", [], |r| {
        r.get(0)
    })?;
    let before = Instant::now();
    let view_before = s.gw.get(&view_url).await?.data().clone();
    if matches!(mode, "off" | "retention" | "capfloor") {
        tokio::time::sleep(Duration::from_secs(33)).await;
    } else {
        wait_pings(&script, if mode == "result" { 2 } else { 1 }).await;
    }
    assert_eq!(
        s.gw.messages(&session).await?,
        baseline,
        "ping wrote conversation messages"
    );
    assert_eq!(
        transcript_sizes(&s)?,
        transcripts,
        "ping wrote transcript entries"
    );
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT COUNT(*) FROM btcc_progress_events", [], |r| r
            .get(0))?,
        progress,
        "ping wrote activity entries"
    );
    let view_after = s.gw.get(&view_url).await?.data().clone();
    assert_eq!(
        view_after["usage"], view_before["usage"],
        "ping changed session usage/cost/request count"
    );
    assert_eq!(
        view_after["context"], view_before["context"],
        "ping changed context meter"
    );
    assert_prefix(&script);
    for pair in script.ping_times.lock().unwrap().windows(2) {
        let gap = pair[1].duration_since(pair[0]);
        assert!(
            gap >= Duration::from_secs(30),
            "ping interval was shortened: {gap:?}"
        );
        eprintln!("keepalive {mode}: ping_gap_ms={}", gap.as_millis());
    }
    if mode == "archive" {
        let reply =
            s.gw.post(&format!("/sessions/{session}/archive"), json!({}))
                .await?;
        assert_eq!(reply.status, 200, "{reply:?}");
    } else if mode == "delete" {
        let reply =
            s.gw.delete(&format!("/sessions/{session}?permanent=true"))
                .await?;
        assert_eq!(reply.status, 200, "{reply:?}");
    } else if mode == "input" {
        s.gw.say(&session, "새 요청입니다. OK라고 답해 주세요.")
            .await?;
    } else if mode == "cancel" {
        let reply =
            s.gw.post(
                &format!(
                    "/steward-relations/{}/cancel",
                    s.gw.get(&view_url).await?.data()["steward_children"]
                        [0]["relation"]["relation_id"]
                        .as_str()
                        .unwrap()
                ),
                json!({"parent_session_id":session}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
    } else if matches!(mode, "result" | "inflight") {
        let resume_started = Instant::now();
        script.release.notify_one();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if s.gw
                .messages(&session)
                .await?
                .iter()
                .any(|m| m["text"] == "원문 확인 결과를 정리했습니다.")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "resume was delayed\n{}",
                s.agent.logs()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        eprintln!(
            "keepalive {mode}: resume_ms={}",
            resume_started.elapsed().as_millis()
        );
        script.ping_release.notify_waiters();
        let requests = script.requests.lock().unwrap();
        assert!(
            !requests
                .last()
                .unwrap()
                .to_string()
                .contains("Cache keepalive."),
            "ping leaked into resume"
        );
    }
    if mode == "cap" {
        tokio::time::sleep(Duration::from_secs(18)).await;
    }
    let pings = script.ping_headers.lock().unwrap().len();
    tokio::time::sleep(Duration::from_secs(
        if matches!(mode, "archive" | "delete") {
            33
        } else {
            3
        },
    ))
    .await;
    assert_eq!(
        script.ping_headers.lock().unwrap().len(),
        pings,
        "maintenance continued after stop"
    );
    if matches!(mode, "off" | "retention") {
        assert_eq!(pings, 0);
    }
    if mode == "failure" {
        assert_eq!(pings, 1);
        let logs = s.agent.logs();
        assert!(logs.contains("session=butler/app-general reason=provider_client_error"));
        assert!(!logs.contains("Stub ping failure"));
        assert_eq!(
            s.agent
                .logs()
                .matches("prompt cache keepalive failed")
                .count(),
            1
        );
    }
    if mode == "cap" { assert_eq!(pings, 1); }
    // At an equal interval/cap deadline the biased stop may win before the ping.
    if mode == "capfloor" { assert!(pings <= 1); }
    let completed = if matches!(mode, "failure" | "inflight") {
        0
    } else {
        pings
    };
    assert_metrics(&s, completed)?;
    eprintln!(
        "keepalive {mode}: pings={pings}, elapsed_ms={}",
        before.elapsed().as_millis()
    );
    script.release.notify_waiters();
    s.finish().await?;
    server.abort();
    Ok(())
}
async fn wait_pings(script: &stub::Script, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(75);
    while script.ping_headers.lock().unwrap().len() < count {
        assert!(Instant::now() < deadline, "keepalive did not fire");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn wait_progress_publication(db: &rusqlite::Connection) -> Result<(), HarnessError> {
    // The held model request has committed progress; its asynchronous
    // outbound+delivery transcript writes must finish before the idle baseline.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let pending: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_progress_events WHERE status='pending')",
            [],
            |row| row.get(0),
        )?;
        if !pending {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "progress publication did not finish"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn assert_prefix(script: &stub::Script) {
    let requests = script.requests.lock().unwrap();
    let wires = script.wires.lock().unwrap();
    let mut original = None;
    let mut parent_scope = None;
    for (index, body) in requests.iter().enumerate() {
        let input = body["input"].as_array().unwrap();
        if input
            .last()
            .unwrap()
            .to_string()
            .contains("Cache keepalive.")
        {
            let (original, original_wire): (&Value, &String) =
                original.expect("parent request before ping");
            let mut restored = body.clone();
            restored["input"].as_array_mut().unwrap().pop();
            let mut expected = original.clone();
            if expected["store"] == true {
                // store precedes input; changing it breaks the physical prefix.
                assert_eq!(body["store"], true);
                if expected.get("max_output_tokens").is_none() {
                    expected["max_output_tokens"] = json!(16);
                }
            }
            assert_eq!(restored, expected, "ping changed fields or prefix");
            let ping_wire = &wires[index];
            let boundary = original_wire.find("\"input\":").unwrap();
            assert_eq!(
                &original_wire[..boundary],
                &ping_wire[..boundary],
                "physical prefix changed"
            );
            for header in script.ping_headers.lock().unwrap().iter() {
                let expected = if original["store"] == true {
                    ""
                } else {
                    original["prompt_cache_key"].as_str().unwrap()
                };
                assert_eq!(header, expected);
            }
        } else if butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default())
            .user_request
            == stub::OWNER
            || parent_scope.as_ref() == body.get("prompt_cache_key")
        {
            parent_scope = body.get("prompt_cache_key").cloned();
            original = Some((body, &wires[index]));
        }
    }
}
fn assert_metrics(s: &Scenario, count: usize) -> Result<(), HarnessError> {
    let rows: Vec<Value> =
        std::fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?;
    let pings: Vec<_> = rows
        .iter()
        .filter(|r| r["prefixDiagnostics"]["trigger"] == "keepalive")
        .collect();
    assert_eq!(pings.len(), count);
    for row in pings {
        let d = &row["prefixDiagnostics"];
        assert_eq!(d["appendOnly"], true);
        assert_eq!(d["lcpBytes"], d["previousPrefixBytes"]);
        assert_eq!(d["lcpPercent"], 100);
        assert!(d["idleGapMs"].as_f64().unwrap() >= 30_000.0);
        assert_eq!(row["phase"], "keepalive");
        assert!(
            row["scope"]
                .as_str()
                .unwrap()
                .starts_with("btcc-keepalive:")
        );
        assert!(row.get("turnId").is_none_or(Value::is_null));
        assert_eq!(d["status"], "completed");
        if d["status"] == "completed" {
            assert_eq!(row["promptTokens"].as_f64(), Some(100.0));
            assert_eq!(row["totalTokens"].as_f64(), Some(120.0));
            assert_eq!(row["cachedTokens"].as_f64(), Some(80.0));
        } else {
            assert!(row["promptTokens"].is_null());
            assert!(row["totalTokens"].is_null());
        }
        assert!(!row.to_string().contains("Cache keepalive."));
    }
    Ok(())
}

fn transcript_sizes(s: &Scenario) -> Result<std::collections::BTreeMap<String, u64>, HarnessError> {
    let root = s.sandbox.data.join("transcripts");
    if !root.exists() {
        return Ok(Default::default());
    }
    std::fs::read_dir(root)?
        .map(|entry| {
            let entry = entry?;
            Ok((
                entry.file_name().to_string_lossy().into_owned(),
                entry.metadata()?.len(),
            ))
        })
        .collect()
}

async fn register_api_route(s: &Scenario) -> Result<(), HarnessError> {
    let credential =
        s.gw.post(
            "/model-catalog/provider-credentials",
            json!({"provider_id":"openai","auth_type":"api_key","api_key":"stub-api-key"}),
        )
        .await?;
    assert_eq!(credential.status, 201, "{}", credential.status);
    let id = credential.data()["credential"]["id"].as_str().unwrap();
    let registered = s.gw.post("/model-catalog/registered-models", json!({
        "provider_id":"openai","model_id":"gpt-6-sol","auth_type":"api_key","credential_id":id
    })).await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    Ok(())
}
