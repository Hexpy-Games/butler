use super::*;

#[tokio::test]
async fn epic_delete_crash_after_app_commit_replays_without_double_effects()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, project, _) = setup("EPIC-DELETE-APP-COMMIT", Access::AskAlways).await?;
    let epic = create(&s, &project).await?;
    let id = epic["id"].as_str().unwrap();
    data(
        s.gw.post(&format!("/canon/epics/{id}/conversation"), json!({}))
            .await?,
        200,
    );
    let canon = db(&s)?;
    canon.execute_batch("CREATE TRIGGER refuse_published BEFORE UPDATE OF published ON canon_events WHEN json_extract(OLD.payload_json,'$.deleted')=1 BEGIN SELECT RAISE(ABORT,'ack unavailable'); END;")?;
    let events = LiveEvents::subscribe(&s.gw, 0).await?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    events
        .wait_for(Duration::from_secs(15), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["id"] == id
                && e["payload"]["deleted"] == true
        })
        .await?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let revision: i64 = app.query_row("SELECT revision FROM app_space_state", [], |r| r.get(0))?;
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_events WHERE published=0 AND json_extract(payload_json,'$.id')=?1 AND json_extract(payload_json,'$.deleted')=1", [id], |r|r.get(0))?, 1);
    s.agent.kill9()?;
    canon.execute_batch("DROP TRIGGER refuse_published")?;
    s.gw = s.agent.start_again().await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_events WHERE published=0 AND json_extract(payload_json,'$.id')=?1 AND json_extract(payload_json,'$.deleted')=1", [id], |r|r.get(0))? > 0 {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(app.query_row::<i64,_,_>("SELECT count(*) FROM events WHERE type='canon.changed' AND json_extract(payload_json,'$.id')=?1 AND json_extract(payload_json,'$.deleted')=1", [id], |r|r.get(0))?, 1);
    assert_eq!(
        app.query_row::<i64, _, _>("SELECT revision FROM app_space_state", [], |r| r.get(0))?,
        revision
    );
    drop(app);
    drop(canon);
    server.abort();
    s.finish().await
}
