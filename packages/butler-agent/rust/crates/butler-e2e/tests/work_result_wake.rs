//! The child result arrives before the parent claim is settled, with no sleeps.
use butler_gateway::gateway::storage_testing::{self, Events};
// test-category: race
#[test]
fn child_result_wakes_after_parent_claim_release() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = std::env::temp_dir().join(format!("result-wake-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root)?;
    let path = root.join("app.sqlite");
    let (sender, thread) = storage_testing::start(path.clone(), vec![])?;
    drop(sender);
    thread.join().map_err(|_| "writer panicked")??;
    let db = rusqlite::Connection::open(path)?;
    db.execute_batch("INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES('parent','Parent','chat','now','now');
        INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES('turn','parent','thinking','Thinking','now','now');
        INSERT INTO session_queued_messages(id,chat_id,text,controls_json,attachments_json,state,turn_id,claim_id,created_at,updated_at)
        VALUES('active','parent','Build','{}','[]','dispatching','turn','claim','now','now');
        INSERT INTO session_queued_messages(id,chat_id,text,controls_json,attachments_json,state,control_resolution_json,created_at,updated_at)
        VALUES('child-result','parent','Delegated result','{}','[]','queued','{\"subsession_result\":{\"result_id\":\"result\"}}','now','now');")?;
    let outcome = Events::default().suspend(&db, "parent", "turn", "claim")?;
    assert_eq!(
        outcome,
        (true, true),
        "settling the claim must wake the pending result"
    );
    assert_eq!(db.query_row("SELECT count(*) FROM session_queued_messages WHERE chat_id='parent' AND state='queued'",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(
        db.query_row(
            "SELECT state FROM session_queued_messages WHERE id='active'",
            [],
            |r| r.get::<_, String>(0)
        )?,
        "dispatched"
    );
    drop(db);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
