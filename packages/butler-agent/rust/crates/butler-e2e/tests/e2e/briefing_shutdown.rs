//! Daily intent survives process shutdown and resumes one logical cycle.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::Value;
use std::time::{Duration, Instant};

use super::briefing_effort::{briefing, briefing_task, general_briefing};

const NOW: &str = "2026-10-02T04:01:00.000Z";

async fn setup(app: bool) -> Result<Scenario, HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let mut setup = Setup::new("BRIEFING-SHUTDOWN")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_APP_NOW", "2026-10-02T03:59:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", address);
    if app {
        setup = setup.app_supervisor();
    }
    super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(briefing);
    for job in ["session-sync", "consolidation-cycle"] {
        std::fs::remove_file(s.sandbox.data.join(format!("state/scheduler/{job}.json")))?;
    }
    super::memory_fixture::arm_consolidation(&s.sandbox.data, "2026-10-02T03:59:00.000Z")?;
    Ok(s)
}

fn marker(s: &Scenario) -> Option<Value> {
    std::fs::read(
        s.sandbox
            .data
            .join("state/scheduler/consolidation-cycle.json"),
    )
    .ok()
    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn intent(s: &Scenario) -> Option<Value> {
    std::fs::read(
        s.sandbox
            .data
            .join("state/scheduler/consolidation-cycle.intent.json"),
    )
    .ok()
    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn calls(s: &Scenario) -> usize {
    s.provider()
        .unwrap()
        .requests()
        .iter()
        .filter(|r| briefing_task(r))
        .count()
}

async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(90), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("daily briefing did not reach its durable boundary");
}

async fn during_model(app: bool) -> Result<(), HarnessError> {
    let mut s = setup(app).await?;
    let gate = s.provider()?.hold_next_reply("general_new_chat_briefing");
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_E2E_APP_NOW", NOW);
    s.gw = s.agent.start_again().await?;
    until(|| calls(&s) == 1).await;
    assert!(general_briefing(&s.sandbox.data).is_none());
    let intent = intent(&s).expect("dispatch must have a durable intent");
    assert_eq!(intent["status"], "pending");
    if app {
        assert!(s.agent.release_foreground_lease());
        let deadline = Instant::now() + Duration::from_secs(30);
        while s.agent.is_running() {
            assert!(Instant::now() < deadline, "App quit did not finish");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(s.agent.reap().unwrap().success());
    } else {
        s.agent.terminate().await?;
    }
    gate.release();
    s.gw = s.agent.start_again().await?;
    settled(&s).await?;
    assert_eq!(
        marker(&s).unwrap()["status"],
        "ok",
        "daily cycle did not complete: {:?}",
        marker(&s)
    );
    let artifact = general_briefing(&s.sandbox.data).expect("briefing lost after shutdown");
    assert_eq!(
        calls(&s),
        2,
        "one interrupted request and one completed request"
    );
    assert_eq!(marker(&s).unwrap()["runId"], intent["runId"]);
    assert_eq!(artifact["source"]["consolidation_run_id"], intent["runId"]);
    let checkpoints = s.sandbox.data.join("cognition/consolidation/checkpoints");
    assert_eq!(
        std::fs::read_dir(checkpoints)?.count(),
        1,
        "one logical cycle"
    );
    s.restart().await?;
    settled(&s).await?;
    // A completed startup tick must retain the artifact and request counts.
    assert_eq!(general_briefing(&s.sandbox.data).unwrap(), artifact);
    assert_eq!(calls(&s), 2);
    eprintln!(
        "BRIEFING-SHUTDOWN app={app} interrupted=1 completed=1 requests={}",
        calls(&s)
    );
    s.finish().await
}

#[tokio::test]
async fn briefing_shutdown_during_model_resumes_daily_cycle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    during_model(false).await
}

#[tokio::test]
async fn briefing_shutdown_app_quit_resumes_daily_cycle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    during_model(true).await
}

// SQLite admission and the existing writer-wait rendezvous locate these
// boundaries without guessing when the daily scheduler will dispatch.
async fn during_admission(before_dispatch: bool) -> Result<(), HarnessError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut s = setup(false).await?;
    let observer = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_E2E_APP_NOW", NOW);
    s.agent.launch.set_env(
        "BUTLER_E2E_WRITE_WAIT_OBSERVER",
        observer.local_addr()?.to_string(),
    );
    s.agent
        .launch
        .set_env("BUTLER_E2E_MEMORY_WRITE_WAIT_MS", "100");
    let gate = s.provider()?.hold_next_reply("general_new_chat_briefing");
    let lock = butler_platform::sqlite::open(
        s.sandbox
            .data
            .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
    )?;
    if before_dispatch {
        lock.execute_batch("BEGIN EXCLUSIVE")?;
    }
    s.gw = s.agent.start_again().await?;
    if !before_dispatch {
        until(|| calls(&s) == 1).await;
        lock.execute_batch("BEGIN EXCLUSIVE")?;
    }
    gate.release();
    let (stream, _) = tokio::time::timeout(Duration::from_secs(90), observer.accept())
        .await
        .expect("daily cycle never reached writer admission")?;
    let mut stream = BufReader::new(stream);
    let mut purpose = String::new();
    stream.read_line(&mut purpose).await?;
    assert_eq!(purpose.trim(), "consolidation");
    assert!(general_briefing(&s.sandbox.data).is_none());
    assert_eq!(calls(&s), usize::from(!before_dispatch));
    let intent = intent(&s).expect("admission must have a durable intent");
    assert_eq!(intent["status"], "pending");
    let logs = s.agent.launch.logs.clone();
    let boundary = "phase=stop_requested edge=event";
    let previous = butler_e2e::e2e::agent::read_all(&logs)
        .matches(boundary)
        .count();
    let done = tokio::sync::Notify::new();
    let (stopped, released) = tokio::join!(
        async {
            let result = s.agent.terminate().await;
            done.notify_one();
            result
        },
        async {
            until(|| {
                butler_e2e::e2e::agent::read_all(&logs)
                    .matches(boundary)
                    .count()
                    > previous
            })
            .await;
            stream.get_mut().write_all(b"x").await?;
            // Keep the actual admission lock until exit. Acknowledge every expired
            // wait so the fixture itself cannot block shutdown or failure settlement.
            loop {
                tokio::select! {
                    () = done.notified() => break,
                    accepted = observer.accept() => {
                        let (stream, _) = accepted?;
                        let mut stream = BufReader::new(stream);
                        let mut purpose = String::new();
                        stream.read_line(&mut purpose).await?;
                        stream.get_mut().write_all(b"x").await?;
                    }
                }
            }
            Ok::<_, HarnessError>(())
        }
    );
    stopped?;
    released?;
    lock.execute_batch("ROLLBACK")?;
    s.agent.launch.remove_env("BUTLER_E2E_WRITE_WAIT_OBSERVER");
    s.gw = s.agent.start_again().await?;
    settled(&s).await?;
    assert_eq!(
        marker(&s).unwrap()["status"],
        "ok",
        "daily cycle did not complete: {:?}",
        marker(&s)
    );
    assert!(general_briefing(&s.sandbox.data).is_some());
    assert_eq!(calls(&s), if before_dispatch { 1 } else { 2 });
    assert_eq!(marker(&s).unwrap()["runId"], intent["runId"]);
    s.restart().await?;
    settled(&s).await?;
    assert_eq!(calls(&s), if before_dispatch { 1 } else { 2 });
    eprintln!(
        "BRIEFING-ADMISSION before_dispatch={before_dispatch} completed=1 requests={}",
        calls(&s)
    );
    s.finish().await
}

#[tokio::test]
async fn briefing_shutdown_before_dispatch_preserves_due_run() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    during_admission(true).await
}

#[tokio::test]
async fn briefing_shutdown_during_admission_preserves_due_run() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    during_admission(false).await
}

async fn settled(s: &Scenario) -> Result<(), HarnessError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let address = s
        .agent
        .launch
        .env
        .iter()
        .find(|(key, _)| key == "BUTLER_E2E_APP_CLOCK_ADDRESS")
        .unwrap()
        .1
        .clone();
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let mut stream = tokio::net::TcpStream::connect(&address).await?;
        stream.write_all(b"\n").await?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).await?;
        let probe: Value = serde_json::from_str(&line)?;
        if probe["context_reads"].as_u64().unwrap() >= 2 {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "startup daily tick never settled"
        );
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn briefing_shutdown_keeps_published_targets_when_resuming_phase() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = setup(false).await?;
    let reply =
        s.gw.post(
            "/projects",
            serde_json::json!({"source":"scratch","display_name":"Today"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let project = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let reply =
        s.gw.post(
            "/sessions",
            serde_json::json!({"kind":"project","title":"A topic","project_id":project}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let gate = s.provider()?.hold_next_reply("project_new_chat_briefing");
    s.agent.terminate().await?;
    s.agent.launch.set_env("BUTLER_E2E_APP_NOW", NOW);
    s.gw = s.agent.start_again().await?;
    until(|| calls(&s) == 2).await;
    let general = general_briefing(&s.sandbox.data).expect("general target not published");
    s.agent.terminate().await?;
    gate.release();
    s.gw = s.agent.start_again().await?;
    settled(&s).await?;
    assert_eq!(
        marker(&s).unwrap()["status"],
        "ok",
        "daily cycle did not complete: {:?}",
        marker(&s)
    );
    assert_eq!(general_briefing(&s.sandbox.data).unwrap(), general);
    let project_path = s
        .sandbox
        .data
        .join("cognition/consolidation/briefings")
        .join(&NOW[..10])
        .join("projects")
        .join(format!("{project}.json"));
    let project_artifact: Value = serde_json::from_slice(&std::fs::read(project_path)?)?;
    assert_eq!(
        project_artifact["source"]["consolidation_run_id"],
        marker(&s).unwrap()["runId"]
    );
    assert_eq!(
        s.provider()?
            .requests()
            .iter()
            .filter(|request| request.to_string().contains("general_new_chat_briefing"))
            .count(),
        1
    );
    assert_eq!(
        calls(&s),
        3,
        "published general target must not call the provider twice"
    );
    s.restart().await?;
    settled(&s).await?;
    assert_eq!(calls(&s), 3);
    eprintln!("BRIEFING-TARGETS completed=2 interrupted=1 requests=3");
    s.finish().await
}

#[path = "briefing_shutdown/lock_held.rs"]
mod lock_held;
