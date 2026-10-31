use super::*;
use stub::delegated::{DIRECTION, STEER};

/// A direction to a project Steward whose Work closed runs on a new Work in the
/// same project. The 과제 keeps its one link and reaches that Work through the
/// relation, and reports done only when the direction's Work is done.
#[tokio::test]
async fn project_steward_direction_keeps_one_work_per_epic() -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CANON-DIRECTION", false, false).await?;
    script.delegate.store(true, Ordering::SeqCst);
    let accepted = s.gw.say(&chat, "Delegate the release verification").await?;
    script.wait_held().await;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&accepted).await?,
        Duration::from_secs(30),
    )
    .await?;
    script.hold_steward.store(true, Ordering::SeqCst);
    script.release();
    tokio::time::timeout(Duration::from_secs(30), script.steward_held.acquire())
        .await
        .expect("Steward result review Turn started")
        .unwrap()
        .forget();
    script.hold_report.store(true, Ordering::SeqCst);
    script.steward_release.add_permits(1);
    script.wait_reporting().await;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (relation, session, root): (String, String, String) = db.query_row(
        "SELECT d.relation_id,r.child_session_id,d.root_work_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r USING(relation_id) WHERE json_extract(d.packet_json,'$.child_role')='steward'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    script.steer_relation.lock().unwrap().clone_from(&relation);
    s.turn(&chat, STEER).await?;
    let pending: i64 = db.query_row(
        "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
        [&relation],
        |row| row.get(0),
    )?;
    assert_eq!(pending, 1, "the settled turn keeps the direction");
    script.finish_report();
    let deadline = Instant::now() + Duration::from_secs(60);
    let statuses = || -> Result<Vec<String>, rusqlite::Error> {
        db.prepare("SELECT status FROM btcc_steward_results WHERE relation_id=?1 ORDER BY rowid")?
            .query_map([&relation], |row| row.get(0))?
            .collect()
    };
    while statuses()?.len() < 2 {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(statuses()?, ["success", "success"]);
    assert!(
        script.requests.lock().unwrap().iter().any(|request| {
            butler_e2e::e2e::matching::key(
                "/codex/responses",
                request,
                &butler_e2e::e2e::sanitize::Placeholders::default(),
            )
            .user_request
            .starts_with(DIRECTION)
        }),
        "the direction opened no Steward turn"
    );
    let links: i64 = db.query_row("SELECT count(*) FROM canon_epic_work_links", [], |r| {
        r.get(0)
    })?;
    assert_eq!(links, 1, "one Work per 과제 survives the direction");
    let works: Vec<(String, String, String)> = db
        .prepare("SELECT work_id,status,scope_kind FROM btcc_guided_works WHERE session_id=?1 ORDER BY rowid")?
        .query_map([&session], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    assert_eq!(works.len(), 2, "{works:?}");
    assert_eq!(works[0].0, root, "the first Work keeps its history");
    assert!(
        works
            .iter()
            .all(|(_, status, scope)| status == "completed" && scope == "project"),
        "{works:?}"
    );
    let current: String = db.query_row(
        "SELECT root_work_id FROM btcc_subsession_delegations WHERE relation_id=?1",
        [&relation],
        |row| row.get(0),
    )?;
    assert_eq!(current, works[1].0, "the relation follows its current Work");
    drop(db);
    wait_label(&s, &id, "in_review").await?;
    let done = progress(&s, &id).await?;
    assert_eq!(done["running"], false, "{done}");
    assert_eq!(done["counts"], json!({"completed":1,"total":1}), "{done}");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_02_15_one_call_parent_settles_from_steward_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CB-02-15", false, false).await?;
    script
        .delegate
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let accepted = s.gw.say(&chat, "Delegate the release verification").await?;
    tokio::time::timeout(Duration::from_secs(30), script.wait_held())
        .await
        .expect("Worker reached its first model round");
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&accepted).await?,
        Duration::from_secs(30),
    )
    .await?;
    let active = progress(&s, &id).await?;
    assert_eq!(
        active["running"], true,
        "Parent delivered, steward still active: {active}"
    );
    // Delegation can end the parent Turn before another model call records a
    // disposition. The running guard is defined by Work.status, not a receipt.
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let status: String = db.query_row("SELECT w.status FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE l.epic_id=?1",[&id],|r|r.get(0))?;
    assert_eq!(status, "open");
    drop(db);
    script
        .hold_steward
        .store(true, std::sync::atomic::Ordering::SeqCst);
    script.release();
    tokio::time::timeout(Duration::from_secs(30), script.steward_held.acquire())
        .await
        .expect("Steward result review Turn started")
        .unwrap()
        .forget();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (original, review): (String,String) = db.query_row("SELECT d.child_turn_id,t.turn_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r USING(relation_id) JOIN btcc_turns t ON t.session_id=r.child_session_id WHERE json_extract(d.packet_json,'$.child_role')='steward' AND t.semantic_state IN ('admitted','delivery_committed') AND t.turn_id<>d.child_turn_id", [], |r| Ok((r.get(0)?,r.get(1)?)))?;
    assert_ne!(original, review, "Result review is a second steward Turn");
    drop(db);
    assert_eq!(progress(&s, &id).await?["running"], true);
    script.steward_release.add_permits(1);
    wait_label(&s, &id, "in_review").await?;
    let done = progress(&s, &id).await?;
    assert_eq!(done["running"], false, "{done}");
    assert_eq!(done["counts"], json!({"completed":1,"total":1}));
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let links: i64 = db.query_row("SELECT count(*) FROM canon_epic_work_links", [], |r| {
        r.get(0)
    })?;
    assert_eq!(
        links, 1,
        "Child Works reach canon through the parent delegation"
    );
    let reviews: i64 = db.query_row(
        "SELECT count(*) FROM (SELECT DISTINCT json_extract(result_json,'$.work.work_id'),json_extract(arguments_json,'$.subject') FROM btcc_guided_tool_calls WHERE tool_name='record_work_review' AND status='completed' AND json_extract(arguments_json,'$.verdict')='accept' AND json_extract(result_json,'$.ok')=1)",
        [], |r| r.get(0),
    )?;
    let parent_calls: i64 = db.query_row(
        "SELECT count(*) FROM btcc_guided_tool_calls c JOIN btcc_turns t USING(turn_id) WHERE t.session_id=(SELECT parent_session_id FROM btcc_session_relations ORDER BY ordinal LIMIT 1) AND c.tool_name IN ('start_work','replace_work_plan','record_work_review','record_work_disposition')",
        [], |r| r.get(0))?;
    assert_eq!(
        parent_calls, 0,
        "Butler hands off in one call and needs no closeout reviews"
    );
    let (status, ledger, packet): (String, String, String) = db.query_row(
        "SELECT w.status,w.ledger_project_id,d.packet_json FROM btcc_subsession_delegations d JOIN btcc_guided_works w ON w.work_id=json_extract(d.packet_json,'$.parent_work_ref.work_id') WHERE json_extract(d.packet_json,'$.child_role')='steward'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    assert_eq!(status, "completed");
    let packet: Value = serde_json::from_str(&packet)?;
    let plan_id = packet["parent_work_ref"]["plan_revision_id"]
        .as_str()
        .unwrap();
    let plan = std::fs::read_to_string(
        s.sandbox
            .data
            .join("project-ledger/projects")
            .join(ledger)
            .join("plans")
            .join(format!("{plan_id}.md")),
    )?;
    let plan: Value = serde_json::from_str(plan.split_once("\n---\n").unwrap().1.trim())?;
    assert_eq!(plan["plan"]["checks"], packet["acceptance_criteria"]);
    assert!(
        packet["parent_work_ref"]
            .get("review_revision_id")
            .is_none()
    );
    drop(db);
    assert_eq!(
        reviews, 6,
        "Steward and Worker keep plan, result and completion reviews; parent has none"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
