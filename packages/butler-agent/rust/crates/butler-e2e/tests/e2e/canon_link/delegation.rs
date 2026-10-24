use super::*;

#[tokio::test]
async fn cb_02_15_parent_report_ends_while_reviewed_steward_still_runs() -> Result<(), HarnessError>
{
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
    script.release();
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
        "SELECT count(*) FROM btcc_guided_work_review_revisions WHERE verdict='accept'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        reviews, 9,
        "Parent, steward and Worker each keep plan, result and completion reviews"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
