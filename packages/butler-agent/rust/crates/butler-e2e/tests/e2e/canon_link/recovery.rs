use super::*;

#[tokio::test]
async fn deleted_epic_link_is_quarantined_without_stopping_canon_events() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CB-QUARANTINE", false, false).await?;
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.pragma_update(None, "foreign_keys", false)?;
    db.execute(
        "UPDATE canon_epic_work_links SET epic_id='deleted-epic' WHERE epic_id=?1",
        [&id],
    )?;
    drop(db);
    let events = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, 0).await?;
    script.release();
    s.gw.wait_terminal(
        &chat,
        &butler_e2e::e2e::scenario::accepted_turn_id(&turn)?,
        Duration::from_secs(60),
    )
    .await?;
    label(&s, &id, "blocked").await?;
    events
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed" && e["payload"].to_string().contains(&id)
        })
        .await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let cursor: i64 = db.query_row(
        "SELECT value FROM canon_cursors WHERE name='progress_feed'",
        [],
        |r| r.get(0),
    )?;
    assert!(
        cursor > 0,
        "The failed link row must not wedge the feed cursor"
    );
    drop(db);
    drop(events);
    s.finish().await?;
    server.abort();
    Ok(())
}
