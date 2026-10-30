use super::*;

#[tokio::test]
async fn start_now_publishes_one_started_revision() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CANON-EDIT-ATOMIC-EVENT", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    let db = seed(&s, &chat, &plan, &epics, true)?;
    // Snapshot the state at event insertion, before any later projection can hide it.
    db.execute_batch("CREATE TABLE observed(payload TEXT,started TEXT); CREATE TRIGGER observe_event AFTER INSERT ON canon_events WHEN NEW.topic='canon.queue_changed' BEGIN INSERT INTO observed SELECT NEW.payload_json,json_group_array(epic_id) FROM (SELECT epic_id FROM canon_session_queue WHERE state='running' ORDER BY epic_id); END;")?;
    let view = data(
        edit(
            &s,
            &chat,
            json!({"expected_graph_revision":10,"op":"start_now","epic_id":epics[2]}),
        )
        .await?,
        200,
    );
    assert_eq!(view["graph_revision"], 11);
    let started = view["chains"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chain| chain["steps"].as_array().unwrap())
        .flat_map(|step| step["items"].as_array().unwrap())
        .filter(|item| item["state"] == "running")
        .map(|item| item["epic_id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(started, vec![json!(epics[2])]);
    let events = db
        .prepare("SELECT payload,started FROM observed")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(events.len(), 1, "one event for the complete edit");
    assert_eq!(
        serde_json::from_str::<Value>(&events[0].0)?,
        json!({"session_id":butler_gateway::gateway::app_session_hint(&chat),"graph_revision":11})
    );
    assert_eq!(serde_json::from_str::<Value>(&events[0].1)?, json!(started));
    let persisted = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(persisted["graph_revision"], 11);
    assert_eq!(order(&persisted, 0), order(&view, 0));
    assert_eq!(persisted["counts"], view["counts"]);
    script.release();
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn readiness_failure_rolls_back_edit_revision_event_and_intent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CANON-EDIT-ATOMIC-FAILURE", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    let db = seed(&s, &chat, &plan, &epics, true)?;
    let path = format!("/sessions/{chat}/canon/queue");
    let before = data(s.gw.get(&path).await?, 200);
    let counts = || -> Result<(i64, i64, i64), rusqlite::Error> {
        db.query_row("SELECT (SELECT count(*) FROM canon_events),(SELECT count(*) FROM canon_intents),(SELECT count(*) FROM canon_session_queue_chains)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))
    };
    let original = counts()?;
    // Fail after membership was saved and its step intent inserted.
    db.execute_batch("CREATE TRIGGER reject_start BEFORE UPDATE OF state ON canon_session_queue WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT,'injected readiness failure'); END;")?;
    let reply = edit(
        &s,
        &chat,
        json!({"expected_graph_revision":10,"op":"start_now","epic_id":epics[2]}),
    )
    .await?;
    assert_eq!(reply.status, 500, "{}", reply.text);
    assert_eq!(data(s.gw.get(&path).await?, 200), before);
    assert_eq!(counts()?, original, "no partial chain, event, or intent");
    assert!(script.requests.lock().unwrap().is_empty());
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
