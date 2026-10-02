//! SVC-01-STARTUP: reserve early, serve only after dispatch owners initialize.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
    stop_intent::instance_record,
};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

async fn held_restart(label: &str) -> Result<Scenario, HarnessError> {
    let mut s = Setup::new(label)?.start().await?;
    let port = s.agent.launch.port;
    let old_pid = s.agent.pid().unwrap();
    s.agent.terminate().await?;
    assert!(s.agent.exit_status(old_pid).unwrap().success());
    s.agent.launch.set_env("BUTLER_E2E_TIER", "stub");
    s.agent.launch.set_env("BUTLER_E2E_HOLD_APP_STARTUP", "1");
    let pid = s.agent.start_process()?;
    assert_ne!(old_pid, pid);
    assert_eq!(s.agent.launch.port, port);
    let held = s.sandbox.data.join("e2e-startup-held");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !held.exists() {
        assert!(s.agent.is_running(), "{}", s.agent.logs());
        assert!(Instant::now() < deadline, "startup did not reach barrier");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let record = instance_record(&s.sandbox.data).unwrap();
    assert_eq!(record["pid"], pid);
    assert_eq!(record["state"], "starting");
    assert!(record["app_endpoint"].is_null());
    let log = std::fs::read_to_string(s.agent.launch.logs.join("agent-2.log"))?;
    assert!(!log.contains("[native-app] ready"), "{log}");
    assert!(!log.contains("[native-butler] ready"), "{log}");
    Ok(s)
}

async fn queued_request(s: &Scenario, method: &str, path: &str) -> Result<TcpStream, HarnessError> {
    let address = format!("127.0.0.1:{}", s.agent.launch.port);
    let mut stream = TcpStream::connect(&address).await?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
        s.gw.token,
    );
    stream.write_all(request.as_bytes()).await?;
    Ok(stream)
}

#[tokio::test]
async fn startup_dispatch_waits_for_initialized_owners() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = held_restart("SVC-01-STARTUP").await?;
    // A completed handshake proves the early bind still reserves the port;
    // no HTTP bytes may arrive while automation initialization is held.
    let mut request = queued_request(&s, "POST", "/automations/dispatch-due").await?;
    let mut first_byte = [0];
    assert!(
        tokio::time::timeout(Duration::from_millis(250), request.read(&mut first_byte),)
            .await
            .is_err(),
        "startup served before owner initialization"
    );
    let mut health = queued_request(&s, "GET", "/health").await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), health.read(&mut first_byte),)
            .await
            .is_err(),
        "health served before owner initialization"
    );
    let released = Instant::now();
    tokio::fs::write(s.sandbox.data.join("e2e-startup-release"), b"release").await?;
    let mut response = String::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        request.read_to_string(&mut response),
    )
    .await
    .expect("queued dispatch did not finish")?;
    assert!(response.starts_with("HTTP/1.1 202"), "{response}");
    let body: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1)?;
    assert_eq!(body["data"]["runs"], serde_json::json!([]));
    assert!(body["error"].is_null(), "{body}");
    let mut health_response = String::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        health.read_to_string(&mut health_response),
    )
    .await
    .expect("queued health did not finish")?;
    assert!(
        health_response.starts_with("HTTP/1.1 200"),
        "{health_response}"
    );
    assert!(s.gw.healthy().await);
    eprintln!(
        "held requests: no HTTP response for 500 ms; dispatch 202 {} ms after release",
        released.elapsed().as_millis()
    );
    s.finish().await
}

#[tokio::test]
async fn runtime_readiness_waits_for_inbound_poll_loop() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SVC-01-DISPATCH-READY")?
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_HOLD_DISPATCH_READY", "1")
        .start()
        .await?;
    let held = s.sandbox.data.join("e2e-dispatch-ready-held");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !held.exists() {
        assert!(s.agent.is_running(), "{}", s.agent.logs());
        assert!(Instant::now() < deadline, "poll loop did not reach barrier");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let pending = s.gw.get("/runtime-readiness").await?;
    assert_eq!(pending.status, 200);
    assert!(
        pending.data()["authenticated_gateway_ready"]
            .as_bool()
            .unwrap()
    );
    assert!(!pending.data()["btcc_executor_ready"].as_bool().unwrap());
    assert!(!pending.data()["raw_text_included"].as_bool().unwrap());
    assert_eq!(instance_record(&s.sandbox.data).unwrap()["state"], "ready");
    let startup_log = std::fs::read_to_string(s.agent.launch.logs.join("agent-1.log"))?;
    assert!(
        startup_log.contains("[native-butler] ready"),
        "{startup_log}"
    );

    assert!(s.gw.healthy().await);
    assert!(!s.gw.executor_ready().await);
    let refused =
        s.gw.post(
            "/messages",
            serde_json::json!({
                "chat_id":"general", "text":"executor barrier", "client_message_id":"held-dispatch"
            }),
        )
        .await?;
    assert_eq!(refused.status, 503, "{}", refused.text);
    assert_eq!(
        refused.error_code(),
        Some("app_transport_executor_unavailable")
    );

    tokio::fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let ready = s.gw.get("/runtime-readiness").await?;
        assert_eq!(ready.status, 200);
        if ready.data()["btcc_executor_ready"].as_bool() == Some(true) {
            assert!(
                ready.data()["authenticated_gateway_ready"]
                    .as_bool()
                    .unwrap()
            );
            break;
        }
        assert!(Instant::now() < deadline, "poll loop did not become ready");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(s.gw.executor_ready().await);
    s.finish().await
}

#[tokio::test]
async fn stalled_startup_exits_at_agent_deadline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = held_restart("SVC-01-STARTUP-DEADLINE").await?;
    let began = Instant::now();
    let deadline = began + Duration::from_secs(95);
    while s.agent.is_running() {
        assert!(
            Instant::now() < deadline,
            "agent startup hung beyond its deadline"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let status = s.agent.reap().unwrap();
    assert!(
        !status.success(),
        "unrequested startup failure must exit nonzero"
    );
    let log = std::fs::read_to_string(s.agent.launch.logs.join("agent-2.log"))?;
    assert!(log.contains("native_service_start_timeout"), "{log}");
    assert!(!log.contains("[native-app] ready"), "{log}");
    let reserved = std::net::TcpListener::bind(("127.0.0.1", s.agent.launch.port))?;
    eprintln!(
        "stalled startup exited after {} ms and released its port",
        began.elapsed().as_millis()
    );
    drop(reserved);
    s.finish().await
}
