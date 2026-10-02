//! Native CLI supervisor death with an actual worker held in CPU initialization.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    faults::{Fault, Transform},
    gateway::turn_state,
    scenario::{Scenario, Setup, accepted_turn_id},
    stop_intent::{StopOnDrop, instance_record},
};
use butler_platform::instance;
use std::{
    fs,
    time::{Duration, Instant},
};

async fn until_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !matches!(instance::process_start(pid), Ok(None)) {
        assert!(Instant::now() < deadline, "orphaned owned process {pid}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn supervisor_death_and_sigterm_reap_native_initializing_workers() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    if !butler_platform::process_control::SIGNALS {
        return Ok(());
    }
    for killed in [true, false] {
        let mut s = Setup::new("SUPERVISOR-NATIVE-OWNER")?
            .stub_cassette(Cassette::load("Q-02")?)
            .start()
            .await?;
        s.agent.terminate().await?;
        let _cleanup = StopOnDrop(s.agent.launch.clone());
        let owners = start_supervised(&mut s).await?;
        let id = active_and_queued(&s).await?;
        let stopped_after = stop_owned(&s, owners, killed).await?;
        recover_queue(&mut s, &id).await?;
        eprintln!(
            "supervisor killed={killed}: shutdown={stopped_after:?}, zero agent/worker survivors; complete queue recovered"
        );
        assert_eq!(s.agent.cli_async(&["stop", "--json"]).await?.code, Some(0));
        s.finish().await?;
    }
    Ok(())
}

async fn start_supervised(s: &mut Scenario) -> Result<(u32, u32, u32), HarnessError> {
    let barrier = s.sandbox.root.join("initializing-worker");
    s.agent.launch.set_env(
        "BUTLER_E2E_EMBED_INIT_BARRIER",
        barrier.display().to_string(),
    );
    let start = s.agent.cli_async(&["start", "--json"]).await?;
    if start.code != Some(0) {
        let log = fs::read_to_string(s.sandbox.data.join("logs/butler-agent-service.stderr.log"))
            .unwrap_or_default();
        panic!("{start:?}\n{log}");
    }
    let record = instance_record(&s.sandbox.data).unwrap();
    let pid = u32::try_from(record["pid"].as_u64().unwrap()).unwrap();
    let supervisor = u32::try_from(record["cli_supervisor_pid"].as_u64().unwrap()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !barrier.exists() {
        assert!(Instant::now() < deadline, "native worker not initializing");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let worker = fs::read_to_string(&barrier)?.parse::<u32>().unwrap();
    Ok((pid, supervisor, worker))
}

async fn active_and_queued(s: &Scenario) -> Result<String, HarnessError> {
    // Hold an active turn and queue a follow-up; shutdown must preserve
    // their durable recovery state while storage is deliberately locked.
    s.provider()?
        .inject(Fault::once(0, Transform::StallAfter(6)))?;
    let id = accepted_turn_id(&s.gw.say("general", "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.").await?)?;
    let served_deadline = Instant::now() + Duration::from_secs(10);
    while s.provider()?.served() == 0 {
        assert!(
            Instant::now() < served_deadline,
            "active request not served"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages.iter().any(|m| {
            m["role"] == "assistant" && m["text"].as_str().is_some_and(|t| t.starts_with("one"))
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "active stream not committed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.gw.post("/session-queue", serde_json::json!({"chat_id":"general", "text":"Reply with exactly the word: waiting", "client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    Ok(id)
}

async fn stop_owned(
    s: &Scenario,
    owners: (u32, u32, u32),
    killed: bool,
) -> Result<Duration, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (pid, supervisor, worker) = owners;
    let began = Instant::now();
    if killed {
        instance::terminate(
            supervisor,
            &instance::process_start(supervisor).unwrap().unwrap(),
        )
        .unwrap();
    } else {
        instance::request_stop(supervisor).unwrap();
    }
    until_gone(pid).await;
    until_gone(worker).await;
    until_gone(supervisor).await;
    let service_logs =
        fs::read_to_string(s.sandbox.data.join("logs/butler-agent-service.stderr.log"))?;
    if !killed {
        assert!(
            began.elapsed() >= Duration::from_secs(6),
            "supervisor bypassed Agent graceful deadline: {:?}\n{service_logs}",
            began.elapsed()
        );
        assert!(
            service_logs.contains("stop deadline reached"),
            "{service_logs}"
        );
    }
    let elapsed = began.elapsed();
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(8),
        "supervisor graceful stop"
    );
    db.execute_batch("ROLLBACK").unwrap();
    Ok(elapsed)
}

async fn recover_queue(s: &mut Scenario, id: &str) -> Result<(), HarnessError> {
    s.agent.launch.remove_env("BUTLER_E2E_EMBED_INIT_BARRIER");
    assert_eq!(s.agent.cli_async(&["start", "--json"]).await?.code, Some(0));
    let turn =
        s.gw.wait_terminal("general", id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages.iter().any(|m| {
            m["role"] == "assistant" && m["text"].as_str().is_some_and(|t| t.contains("waiting"))
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "queued follow-up did not drain");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}
