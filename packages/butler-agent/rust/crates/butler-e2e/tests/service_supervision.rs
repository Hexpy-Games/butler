//! Real CLI service crashes, with a private systemd stand-in and without a manager.
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
use butler_platform::{
    instance,
    service_registration::{self, Definition, Manager},
};
use serde_json::{Value, json};
use std::{
    fs,
    process::Stdio,
    time::{Duration, Instant},
};

const LONG: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

struct ManagerTask(tokio::task::JoinHandle<()>);
impl Drop for ManagerTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn managed_fixture(s: &mut Scenario) -> Result<ManagerTask, HarnessError> {
    let launch = &mut s.agent.launch;
    let definition = Definition {
        program: launch.binary.clone(),
        args: vec![
            "service".into(),
            "run".into(),
            "--data".into(),
            launch.data.display().to_string(),
            "--detached".into(),
        ],
        working_dir: launch.data.clone(),
        env: vec![],
    };
    let rendered = service_registration::render(Manager::SystemdUser, &definition)
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    assert!(rendered.contains("Restart=on-failure"));
    assert!(!rendered.contains("RestartPreventExitStatus=SIGKILL"));
    let bin = service_registration::test_support::systemd_fixture(
        &s.sandbox.root,
        &launch.home,
        &definition,
    )?;
    launch.set_env("PATH", format!("{}:/usr/bin:/bin", bin.display()));
    launch.set_env("BUTLER_AGENT_HOME", launch.install.display().to_string());
    launch.set_env("BUTLER_SERVICE_MANAGER", "on");
    launch.set_env(
        "BUTLER_E2E_MANAGER_ROOT",
        s.sandbox.root.display().to_string(),
    );
    let root = s.sandbox.root.clone();
    let launch = launch.clone();
    Ok(ManagerTask(tokio::spawn(async move {
        while !root.join("manager-start").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        loop {
            let logs = launch.data.join("logs");
            fs::create_dir_all(&logs).unwrap();
            let mut command = tokio::process::Command::from(launch.command());
            command
                .args(["service", "run", "--detached"])
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .stdout(
                    fs::OpenOptions::new()
                        .append(true)
                        .create(true)
                        .open(logs.join("butler-agent-service.stdout.log"))
                        .unwrap(),
                )
                .stderr(
                    fs::OpenOptions::new()
                        .append(true)
                        .create(true)
                        .open(logs.join("butler-agent-service.stderr.log"))
                        .unwrap(),
                );
            let mut child = command.spawn().unwrap();
            fs::write(
                root.join("manager-pid"),
                format!("{}\n", child.id().unwrap()),
            )
            .unwrap();
            if child.wait().await.unwrap().success() {
                break;
            }
            // Emulate the unit's restart policy, retaining the manager as parent.
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })))
}

async fn ready(s: &Scenario, old_pid: u32) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(record) = instance_record(&s.sandbox.data)
            && record["pid"] != old_pid
            && record["state"] == "ready"
            && s.gw.healthy().await
        {
            return Ok(record);
        }
        assert!(Instant::now() < deadline, "service did not return");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn assert_failed_and_drained(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_terminal("general", id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["retryable"], true);
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_ne!(view.data()["active_turn"]["id"], id, "{}", view.text);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.iter().any(|t| turn_state(t) == "delivered") {
            assert_eq!(turns.len(), 2, "{turns:?}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queued followup stuck: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        s.provider()?.served(),
        2,
        "active work automatically resumed"
    );
    let queue = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(queue.data()["paused"], false);
    assert!(
        queue.data()["queued_messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["state"] != "queued")
    );
    let status = s.agent.cli_async(&["status", "--json"]).await?;
    assert_eq!(status.code, Some(0), "{status:?}");
    assert!(status.stdout.contains("online"), "{status:?}");
    Ok(())
}

async fn exercise(managed: bool, replacement: bool) -> Result<(), HarnessError> {
    let mut s = Setup::new("SERVICE-SUPERVISION")?
        .stub_cassette(Cassette::load("Q-02")?)
        .start()
        .await?;
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_E2E_FORCE_SERVICE_EXIT", "1");
    let _manager = if managed {
        Some(managed_fixture(&mut s)?)
    } else {
        None
    };
    let cleanup = StopOnDrop(s.agent.launch.clone());
    let start = s.agent.cli_async(&["start", "--json"]).await?;
    assert_eq!(start.code, Some(0), "{start:?}");
    let record = instance_record(&s.sandbox.data).unwrap();
    assert_eq!(record["cli_supervisor_pid"].is_null(), managed, "{record}");
    let pid = u32::try_from(record["pid"].as_u64().unwrap()).unwrap();
    s.provider()?
        .inject(Fault::once(0, Transform::StallAfter(6)))?;
    let id = accepted_turn_id(&s.gw.say("general", LONG).await?)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    s.gw.post(
        "/session-queue",
        json!({"chat_id":"general","text":"Reply with exactly the word: waiting",
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
    )
    .await?;
    let began = Instant::now();
    if replacement {
        fs::write(s.sandbox.data.join("e2e-service-exit"), b"once")?;
    } else {
        instance::terminate(pid, record["process_start"].as_str().unwrap())
            .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    }
    let new = ready(&s, pid).await?;
    assert_ne!(new["pid"], pid);
    assert_eq!(new["cli_supervisor_pid"], record["cli_supervisor_pid"]);
    assert_failed_and_drained(&s, &id).await?;
    eprintln!(
        "managed={managed} replacement={replacement} ready_and_queue={:?}",
        began.elapsed()
    );
    let stop = s.agent.cli_async(&["stop", "--json"]).await?;
    assert_eq!(stop.code, Some(0), "{stop:?}");
    drop(cleanup);
    s.finish().await
}

#[tokio::test]
async fn cli_supervisor_recovers_sigkill_and_replacement_required() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    exercise(false, false).await?;
    exercise(false, true).await
}

#[tokio::test]
async fn managed_service_recovers_sigkill_and_replacement_required() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        service_registration::manager() == Manager::SystemdUser,
        "systemd contract E2E"
    );
    exercise(true, false).await?;
    exercise(true, true).await
}

#[tokio::test]
async fn cli_supervisor_caps_crashes_and_a_new_start_recovers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SERVICE-CRASH-CAP")?.start().await?;
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_E2E_FORCE_SERVICE_EXIT", "1");
    let cleanup = StopOnDrop(s.agent.launch.clone());
    let start = s.agent.cli_async(&["start", "--json"]).await?;
    assert_eq!(start.code, Some(0), "{start:?}");
    let supervisor = instance_record(&s.sandbox.data).unwrap()["cli_supervisor_pid"].clone();
    for crash in 0..5 {
        let record = instance_record(&s.sandbox.data).unwrap();
        fs::write(s.sandbox.data.join("e2e-service-exit"), b"once")?;
        if crash < 4 {
            let next = ready(&s, u32::try_from(record["pid"].as_u64().unwrap()).unwrap()).await?;
            assert_eq!(next["cli_supervisor_pid"], supervisor);
        }
    }
    let logs = s.sandbox.data.join("logs/butler-agent-service.stderr.log");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !fs::read_to_string(&logs)?.contains("code=crash_loop_cap") {
        assert!(Instant::now() < deadline, "crash loop did not stop");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!s.gw.healthy().await);
    s.agent.launch.remove_env("BUTLER_E2E_FORCE_SERVICE_EXIT");
    let start = s.agent.cli_async(&["start", "--json"]).await?;
    assert_eq!(start.code, Some(0), "{start:?}");
    assert_ne!(
        instance_record(&s.sandbox.data).unwrap()["cli_supervisor_pid"],
        supervisor
    );
    assert!(s.gw.healthy().await);
    drop(cleanup);
    s.finish().await
}

#[tokio::test]
async fn cli_supervisor_rejects_stop_intent_for_another_instance() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SERVICE-STALE-STOP")?.start().await?;
    s.agent.terminate().await?;
    let cleanup = StopOnDrop(s.agent.launch.clone());
    let start = s.agent.cli_async(&["start", "--json"]).await?;
    assert_eq!(start.code, Some(0));
    let record = instance_record(&s.sandbox.data).unwrap();
    let pid = u32::try_from(record["pid"].as_u64().unwrap()).unwrap();
    fs::write(
        s.sandbox.data.join("state/agent-stop-intent.json"),
        json!({
            "schema":"butler.agent-stop-intent.v1", "pid":pid,
            "instance_id":uuid::Uuid::new_v4().to_string(), "reason":"stop",
            "requested_by":"cli", "respawn_by":null, "requested_at":"2026-10-02T00:00:00Z"
        })
        .to_string(),
    )?;
    instance::terminate(pid, record["process_start"].as_str().unwrap())
        .map_err(|error| HarnessError(error.to_string()))?;
    let next = ready(&s, pid).await?;
    assert_eq!(next["cli_supervisor_pid"], record["cli_supervisor_pid"]);
    let stop = s.agent.cli_async(&["stop", "--json"]).await?;
    assert_eq!(stop.code, Some(0));
    drop(cleanup);
    s.finish().await
}
