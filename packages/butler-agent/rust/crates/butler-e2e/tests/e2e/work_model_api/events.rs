use super::*;
use rusqlite::Connection;

fn app_db(s: &Scenario) -> Result<Connection, HarnessError> {
    Ok(Connection::open(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
    )?)
}
fn work_db(s: &Scenario) -> Result<Connection, HarnessError> {
    Ok(Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}

#[tokio::test]
async fn startup_replays_unpublished_events_without_duplicates_and_prunes_receipts()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WMA-EVENT-RECOVERY")?.start().await?;
    data(
        s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
            .await?,
        200,
    );
    let project = project(&s).await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let plan = create_plan(&s, &project, "Plan").await?;
    let id = plan["id"].as_str().unwrap();
    let original = event(&stream, "canon.changed", id).await?;
    drop(stream);
    s.agent.terminate().await?;
    let work = work_db(&s)?;
    let seq: i64 = work.query_row(
        "SELECT seq FROM wm_outbox WHERE json_extract(payload_json,'$.id')=?1",
        [id],
        |r| r.get(0),
    )?;
    // Persist the state immediately after App append, before BTCC ack.
    work.execute("UPDATE wm_outbox SET published=0 WHERE seq=?1", [seq])?;
    let app = app_db(&s)?;
    app.execute(
        "INSERT OR REPLACE INTO app_work_model_events VALUES(?1,?2)",
        rusqlite::params![seq, original["id"].as_i64().unwrap()],
    )?;
    work.execute("INSERT INTO wm_outbox(topic,payload_json,created_at) VALUES('canon.changed',?1,1)",
        [json!({"project_id":project,"kind":"plan","id":"offline","revision":0,"origin":"local"}).to_string()])?;
    app.execute_batch(
        "CREATE TRIGGER fail_work_receipt BEFORE INSERT ON app_work_model_events
        BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;",
    )?;
    drop(work);
    drop(app);
    s.restart().await?;
    let attempts = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let logs = data(s.gw.get("/logs?category=butler_gateway%3A%3Agateway%3A%3Aapplication%3A%3Awork_model%3A%3Aevents").await?, 200);
            let count = logs["rows"].as_array().unwrap().iter()
                .filter(|row| row["msg"] == "Work model event drain failed").count();
            if count >= 2 { return Ok::<_, HarnessError>(count); }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("publisher retries once while idle")?;
    assert_eq!(attempts, 2);
    s.agent.terminate().await?;
    let app = app_db(&s)?;
    // Both failed App transactions rolled back; the old receipt still guards
    // the crash window and the new event has not been lost or acknowledged.
    assert_eq!(
        app.query_row::<i64, _, _>("SELECT count(*) FROM app_work_model_events", [], |r| r
            .get(0))?,
        1
    );
    app.execute_batch("DROP TRIGGER fail_work_receipt")?;
    drop(app);
    s.restart().await?;
    let stream = LiveEvents::subscribe(&s.gw, original["id"].as_u64().unwrap()).await?;
    let recovered = event(&stream, "canon.changed", "offline").await?;
    assert_eq!(recovered["payload"]["event_seq"], recovered["id"]);
    drop(stream);
    s.agent.terminate().await?;
    let app = app_db(&s)?;
    let count: i64 = app.query_row("SELECT count(*) FROM events WHERE type='canon.changed' AND json_extract(payload_json,'$.id')=?1", [id], |r| r.get(0))?;
    assert_eq!(count, 1);
    assert_eq!(
        app.query_row::<i64, _, _>("SELECT count(*) FROM app_work_model_events", [], |r| r
            .get(0))?,
        0
    );
    let work = work_db(&s)?;
    assert_eq!(
        work.query_row::<i64, _, _>(
            "SELECT count(*) FROM wm_outbox WHERE published=0",
            [],
            |r| r.get(0)
        )?,
        0
    );
    drop(work);
    drop(app);
    s.finish().await
}
