use super::*;

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
        &butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?,
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
