//! Parent directions reach active turns and continue completed assignments.
use super::*;

#[tokio::test]
async fn parent_direction_reaches_the_running_child_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = setup("STEWARD-ACTIVE-DIRECTION", &url)?.env("BUTLER_E2E_HOLD_TOOL", "read_file");
    for (name, text) in [("a.txt", "Approach A"), ("b.txt", "Approach B")] {
        std::fs::write(setup.sandbox.data.join(name), text)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = &view.data()["steward_children"][0];
    let relation = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let turn: String = db.query_row(
        "SELECT turn_id FROM wm_attempts WHERE session_id=?1 ORDER BY started_at DESC LIMIT 1",
        [child["session_id"].as_str().unwrap()],
        |row| row.get(0),
    )?;
    *script.relation.lock().unwrap() = relation.clone();
    std::fs::write(s.sandbox.data.join("e2e-hold-tool"), b"once")?;
    script.release.notify_one();
    wait_held_tool(&s).await?;
    s.turn("general", stub::DIRECTION).await?;
    std::fs::remove_file(s.sandbox.data.join("e2e-hold-tool"))?;
    let complete = wait_result(&s).await?;
    assert_eq!(complete["result"]["status"], "success", "{complete}");
    assert_eq!(complete["result"]["child_turn_id"], turn);
    assert_direction(&s, &script, relation);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn parent_direction_continues_a_completed_part() -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.release.notify_one();
    let setup = setup("STEWARD-COMPLETED-DIRECTION", &url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    let child = wait_result(&s).await?;
    let relation = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = child["session_id"].as_str().unwrap();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (task, part): (String, String) = db.query_row(
        "SELECT task_id,part_id FROM wm_attempts WHERE session_id=?1 ORDER BY started_at LIMIT 1",
        [session],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let original: String = db.query_row(
        "SELECT status FROM wm_task_parts WHERE id=?1",
        [&part],
        |r| r.get(0),
    )?;
    assert_eq!(original, "completed");
    *script.relation.lock().unwrap() = relation.clone();
    script.hold_direction.store(true, Ordering::SeqCst);
    s.turn("general", stub::DIRECTION).await?;
    tokio::time::timeout(Duration::from_secs(20), script.direction_held.notified())
        .await
        .unwrap_or_else(|_| panic!("completed assignment never continued\n{}", s.agent.logs()));
    let (continued_task, continued_part, status): (String, String, String) = db.query_row(
        "SELECT a.task_id,a.part_id,p.status FROM wm_attempts a JOIN wm_task_parts p ON p.id=a.part_id WHERE a.session_id=?1 ORDER BY a.started_at DESC,a.id DESC LIMIT 1",
        [session], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    assert_eq!(continued_task, task);
    assert_ne!(continued_part, part);
    assert_eq!(status, "running");
    let original: String = db.query_row(
        "SELECT status FROM wm_task_parts WHERE id=?1",
        [&part],
        |r| r.get(0),
    )?;
    assert_eq!(original, "completed");
    assert!(script.requests.lock().unwrap().iter().any(|request| {
        stub::child_lane(request) && request.to_string().contains(stub::DIRECTION)
    }));
    s.finish().await?;
    server.abort();
    Ok(())
}
