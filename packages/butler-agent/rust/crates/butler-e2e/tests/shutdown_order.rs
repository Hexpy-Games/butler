//! Shutdown drains turns while the App projection and transcript are still open.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk},
    gateway::turn_state,
    provider::Pacing,
    scenario::{Scenario, Setup, accepted_turn_id},
    stop_intent::{control_command, instance_record, intent_path},
};
use serde_json::json;
use std::time::{Duration, Instant};

#[path = "shutdown_order/diagnostics.rs"]
mod diagnostics;

#[tokio::test]
async fn stop_interrupts_a_thirty_second_stream_before_closing_storage() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, turn_id) = streaming_scenario("SHUTDOWN-STREAM").await?;
    let record = instance_record(&s.sandbox.data).unwrap();
    std::fs::write(
        intent_path(&s.sandbox.data),
        json!({
            "schema":"butler.agent-stop-intent.v1", "reason":"stop", "requested_by":"cli",
            "respawn_by":null, "instance_id":record["nonce"], "pid":record["pid"],
            "requested_at":"2026-09-30T00:00:00.000Z"
        })
        .to_string(),
    )?;
    let started = Instant::now();
    assert_eq!(
        control_command(&record, "service_stop", None)?["result"]["ok"],
        true
    );
    while s.agent.is_running() {
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "stop exceeded grace"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(s.agent.reap().unwrap().success());
    eprintln!("stream shutdown: {:?}", started.elapsed());
    assert!(!s.agent.logs().contains("app_sqlite_owner_closed"));
    assert!(
        instance_record(&s.sandbox.data).is_none(),
        "instance record not released"
    );
    let transcript = butler_e2e::e2e::agent::read_all(&s.sandbox.data.join("transcripts"));
    assert!(
        transcript
            .lines()
            .any(|line| line.contains(&turn_id) && line.contains("turn_interrupted")),
        "terminal interruption was not flushed"
    );
    s.gw = s.agent.start_again().await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(10))
            .await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], "turn_interrupted", "{turn}");
    assert_eq!(
        s.provider()?.served(),
        1,
        "model was called again after stop"
    );
    s.finish().await
}

#[tokio::test]
async fn stop_reaps_a_hung_mcp_server_and_releases_the_instance() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SHUTDOWN-MCP")?.start().await?;
    let pid_file = s.sandbox.root.join("mcp.pid");
    let descendant_file = s.sandbox.root.join("mcp-descendant.pid");
    let added =
        s.gw.post(
            "/mcp-servers",
            json!({
                "id":"hung", "display_name":"Hung fixture", "enabled":true, "transport":"stdio",
                "command":env!("CARGO_BIN_EXE_e2e-mcp-fixture"), "args":[], "env":[
                    {"key":"E2E_MCP_MODE", "source":"literal", "value":"hang_init"},
                    {"key":"E2E_MCP_PID_FILE", "source":"literal", "value":pid_file},
            {"key":"E2E_MCP_CHILD_PID_FILE", "source":"literal", "value":descendant_file}
                ]
            }),
        )
        .await?;
    assert!(added.status < 300, "{}", added.text);
    let gw = s.gw.clone();
    let probe = tokio::spawn(async move { gw.post("/mcp-servers/hung/probe", json!({})).await });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !pid_file.exists() || !descendant_file.exists() {
        assert!(Instant::now() < deadline, "MCP never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let pid: u32 = std::fs::read_to_string(pid_file)?.parse().unwrap();
    let descendant: u32 = std::fs::read_to_string(descendant_file)?.parse().unwrap();
    let started = Instant::now();
    s.agent.terminate().await?;
    let alive = butler_platform::process_control::liveness(pid);
    // Clean up the exact recorded fixture PID even when the regression fails.
    if alive != butler_platform::process_control::Liveness::Gone {
        let _ = butler_platform::instance::request_stop(pid);
    }
    let descendant_alive = butler_platform::process_control::liveness(descendant);
    if descendant_alive != butler_platform::process_control::Liveness::Gone {
        let _ = butler_platform::instance::request_stop(descendant);
    }
    probe.abort();
    let _ = probe.await;
    eprintln!(
        "hung MCP shutdown: {:?}, child={alive:?}",
        started.elapsed()
    );
    assert!(started.elapsed() < Duration::from_secs(8));
    assert_eq!(
        alive,
        butler_platform::process_control::Liveness::Gone,
        "orphan PID {pid}"
    );
    assert_eq!(
        descendant_alive,
        butler_platform::process_control::Liveness::Gone,
        "orphan descendant PID {descendant}"
    );
    assert!(instance_record(&s.sandbox.data).is_none());
    s.finish().await
}

#[tokio::test]
async fn sigterm_during_store_open_never_publishes_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !butler_platform::process_control::SIGNALS {
        return Ok(());
    }
    let mut s = Setup::new("SHUTDOWN-STARTUP")?.start().await?;
    s.agent.terminate().await?;
    let lock = rusqlite::Connection::open(s.sandbox.data.join("runtime/session-store.sqlite"))
        .map_err(|e| HarnessError(e.to_string()))?;
    lock.execute_batch("BEGIN EXCLUSIVE")
        .map_err(|e| HarnessError(e.to_string()))?;
    let pid = s.agent.start_process()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(record) = instance_record(&s.sandbox.data).filter(|r| r["pid"] == pid) {
            assert_eq!(record["state"], "starting");
            break;
        }
        assert!(Instant::now() < deadline, "no starting instance");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    butler_platform::instance::request_stop(pid).map_err(|e| HarnessError(e.to_string()))?;
    let started = Instant::now();
    while s.agent.is_running() {
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "startup stop missed deadline"
        );
        if let Some(record) = instance_record(&s.sandbox.data) {
            assert_ne!(record["state"], "ready");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(s.agent.reap().unwrap().success());
    assert!(instance_record(&s.sandbox.data).is_none());
    lock.execute_batch("ROLLBACK")
        .map_err(|e| HarnessError(e.to_string()))?;
    eprintln!("blocked startup SIGTERM: {:?}", started.elapsed());
    s.finish().await
}

#[tokio::test]
async fn shutdown_interrupts_a_control_request_read() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    control_read_shutdown("read").await?;
    if butler_platform::process_control::SIGNALS {
        control_read_shutdown("cancel-before-wait").await?;
    }
    Ok(())
}

async fn control_read_shutdown(order: &str) -> Result<(), HarnessError> {
    use tokio::io::AsyncWriteExt;
    let mut s = Setup::new("SHUTDOWN-CONTROL")?
        .env("BUTLER_E2E_CONTROL_SHUTDOWN_ORDER", order)
        .start()
        .await?;
    let record = instance_record(&s.sandbox.data).unwrap();
    let endpoint = record["control_endpoint"].as_str().unwrap();
    let mut stream = tokio::net::TcpStream::connect(endpoint).await?;
    stream.write_all(&[0, 0]).await?; // An unfinished frame holds serve_one.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !s.sandbox.data.join("e2e-control-accepted").exists() {
        assert!(
            Instant::now() < deadline,
            "control connection never accepted"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = Instant::now();
    s.agent.terminate().await.map_err(|error| {
        HarnessError(format!("{error}; {}", diagnostics::snapshot(&s, started)))
    })?;
    eprintln!(
        "blocked control shutdown ({order}): {:?}",
        started.elapsed()
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "control shutdown exceeded 2s; {}",
        diagnostics::snapshot(&s, started)
    );
    assert!(
        instance_record(&s.sandbox.data).is_none(),
        "control shutdown left its record; {}",
        diagnostics::snapshot(&s, started)
    );
    if order == "cancel-before-wait" {
        assert!(s.agent.logs().contains("control_cancelled_before_wait"));
        assert!(s.agent.logs().contains("control_connection_cancelled"));
    }
    s.finish().await
}

async fn streaming_scenario(id: &str) -> Result<(Scenario, String), HarnessError> {
    let mut cassette = Cassette::load("TURN-03")?;
    cassette.exchanges.truncate(1);
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let body = cassette.exchanges[0].response.body();
    cassette.exchanges[0].response.chunks = body
        .split("\n\n")
        .filter(|s| !s.is_empty())
        .map(|text| Chunk {
            delay_ms: 0,
            text: format!("{text}\n\n"),
        })
        .collect();
    let chunks = &mut cassette.exchanges[0].response.chunks;
    let delayed = chunks.len().saturating_sub(5).max(1);
    for (index, chunk) in chunks.iter_mut().enumerate() {
        // Publish the first text delta immediately, then stream for 30 seconds.
        chunk.delay_ms = if index < 5 {
            0
        } else {
            30_000 / delayed as u64
        };
    }
    let s = Setup::new(id)?.stub_cassette(cassette).start().await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 30_000,
        min_ms: 0,
    });
    let accepted = s.gw.say("general", &prompt).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let turn = s.gw.turn("general", &turn_id).await?.unwrap();
        if s.gw.messages("general").await?.iter().any(|message| {
            message["turn_id"] == turn_id
                && message["text"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("one"))
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "stream never started: {turn}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok((s, turn_id))
}

#[tokio::test]
async fn unannounced_sigterm_has_a_deadline_even_when_storage_is_blocked()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !butler_platform::process_control::SIGNALS {
        return Ok(());
    }
    let (mut s, turn_id) = streaming_scenario("SHUTDOWN-DEADLINE").await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
        .map_err(|e| HarnessError(e.to_string()))?;
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| HarnessError(e.to_string()))?;
    let started = Instant::now();
    butler_platform::instance::request_stop(s.agent.pid().unwrap())
        .map_err(|e| HarnessError(e.to_string()))?;
    while s.agent.is_running() {
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "unannounced stop missed deadline; {}",
            diagnostics::snapshot(&s, started)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let exit_observed = started.elapsed();
    let status = s.agent.reap().unwrap();
    eprintln!(
        "forced shutdown: exit_observed={exit_observed:?} reaped={:?} status={status}",
        started.elapsed()
    );
    assert!(status.success(), "{}", diagnostics::snapshot(&s, started));
    assert!(
        s.agent.logs().contains("stop deadline reached"),
        "lock did not exercise forced cleanup; {}",
        diagnostics::snapshot(&s, started)
    );
    assert!(
        instance_record(&s.sandbox.data).is_none(),
        "forced exit left its record; {}",
        diagnostics::snapshot(&s, started)
    );
    let transcript = butler_e2e::e2e::agent::read_all(&s.sandbox.data.join("transcripts"));
    assert!(transcript.contains(&turn_id));
    for line in transcript.lines().filter(|line| !line.is_empty()) {
        serde_json::from_str::<serde_json::Value>(line)?;
    }
    eprintln!("unannounced forced deadline: {:?}", started.elapsed());
    db.execute_batch("ROLLBACK")
        .map_err(|e| HarnessError(e.to_string()))?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(10))
            .await?;
    assert!(
        matches!(turn_state(&turn), "failed" | "runtime_fault"),
        "{turn}"
    );
    assert_eq!(turn["safe_error_code"], "turn_interrupted", "{turn}");
    assert_eq!(s.provider()?.served(), 1, "forced stop resumed model work");
    s.finish().await
}
