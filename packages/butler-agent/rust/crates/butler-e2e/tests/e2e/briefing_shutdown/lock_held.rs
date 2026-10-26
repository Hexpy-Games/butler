//! A contended due run still finishes configured maintenance without a wakeup.
use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn daily_lock_held_runs_configured_and_counts_as_done() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup(false).await?;
    s.agent.terminate().await?;
    let observer = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    s.agent.launch.set_env("BUTLER_E2E_APP_NOW", NOW);
    s.agent.launch.set_env(
        "BUTLER_E2E_WRITE_WAIT_OBSERVER",
        observer.local_addr()?.to_string(),
    );
    s.agent
        .launch
        .set_env("BUTLER_E2E_MEMORY_WRITE_WAIT_MS", "100");
    let lock = butler_platform::sqlite::open(
        s.sandbox
            .data
            .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
    )?;
    lock.execute_batch("BEGIN EXCLUSIVE")?;
    s.gw = s.agent.start_again().await?;
    let (stream, _) = tokio::time::timeout(Duration::from_secs(90), observer.accept())
        .await
        .expect("daily cycle did not attempt writer admission")?;
    let mut stream = BufReader::new(stream);
    let mut purpose = String::new();
    stream.read_line(&mut purpose).await?;
    assert_eq!(purpose.trim(), "consolidation");
    assert_eq!(intent(&s).unwrap()["status"], "pending");
    // Admission has already expired. Release the other writer before allowing
    // LockHeld to return, so configured phases can acquire their own leases.
    lock.execute_batch("ROLLBACK")?;
    stream.write_all(b"1").await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while marker(&s).is_none_or(|state| state["lastRunDate"] != NOW[..10]) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("contended daily run did not complete");
    let completed = marker(&s).unwrap();
    assert_eq!(completed["lastRunDate"], &NOW[..10]);
    assert_eq!(completed["status"], "ok", "{completed}");
    assert_eq!(calls(&s), 0);
    assert!(general_briefing(&s.sandbox.data).is_none());
    let logs = s.sandbox.data.join("cognition/consolidation/logs");
    let events: Vec<Value> = std::fs::read_dir(logs)?
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .flat_map(|text| {
            text.lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<Value>>()
        })
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|event| event["phase"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["catchup", "consolidate", "optimize", "health"]
    );
    assert!(
        events.iter().all(|event| event["status"] == "ok"),
        "{events:?}"
    );
    let summary = s
        .sandbox
        .data
        .join("cognition/consolidation/run-summary.jsonl");
    let before = std::fs::read(&summary)?;
    s.restart().await?;
    settled(&s).await?;
    assert_eq!(marker(&s).unwrap(), completed);
    assert_eq!(std::fs::read(summary)?, before);
    assert_eq!(calls(&s), 0);
    eprintln!("DAILY-LOCK-HELD configured=4 briefing=0 day_done=true");
    s.finish().await
}
