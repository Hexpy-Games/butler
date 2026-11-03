//! Terminal cards close their execution authority before any follow-up starts.
use super::*;

#[tokio::test]
async fn failed_delegation_followup_has_new_card_and_closed_runtime() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false, true).await
}

pub(crate) fn assert_closed(db: &rusqlite::Connection, card_session: &str) {
    let terminal: bool = db.query_row(
        "SELECT activity_terminal FROM btcc_session_relations WHERE child_session_id=?1",
        [card_session], |row| row.get(0),
    ).unwrap();
    assert!(terminal, "card relation must be terminal");
    let (turns, works): (i64, i64) = db.query_row(
        "WITH RECURSIVE closing(session) AS (SELECT ?1 UNION
         SELECT r.child_session_id FROM closing c JOIN btcc_session_relations r ON r.parent_session_id=c.session)
         SELECT (SELECT count(*) FROM btcc_turns WHERE session_id IN (SELECT session FROM closing)
                 AND semantic_state IN ('admitted','delivery_committed')),
                (SELECT count(*) FROM btcc_guided_works WHERE session_id IN (SELECT session FROM closing)
                 AND status IN ('open','blocked'))",
        [card_session], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(turns, 0, "terminal card and descendants have no active turn");
    assert_eq!(works, 0, "terminal card and descendants have no open Work");
}

#[tokio::test]
async fn restart_in_the_middle_of_card_closeout_finishes_the_same_ending()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let held = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let first = Arc::new(AtomicBool::new(true));
    let barrier = {
        let (held, release, first) = (held.clone(), release.clone(), first.clone());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (held, release, first) = (held.clone(), release.clone(), first.clone());
                tokio::spawn(async move {
                    let mut stage = [0; 6];
                    socket.read_exact(&mut stage).await.unwrap();
                    assert_eq!(&stage, b"fenced");
                    if first.swap(false, Ordering::SeqCst) {
                        held.notify_one();
                        release.notified().await;
                    }
                    let _ = socket.write_u8(1).await;
                });
            }
        })
    };
    let (url, script, server) = stub::start(true).await?;
    let mut s = Setup::new("ENDING-CRASH")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_E2E_ENDING_BARRIER", address.to_string())
        .start()
        .await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .unwrap();
    let first = children(&s).await?.remove(0);
    let relation = first["relation"]["relation_id"].as_str().unwrap();
    s.gw.post(
        &format!("/steward-relations/{relation}/cancel"),
        json!({"parent_session_id":"general"}),
    )
    .await?;
    tokio::time::timeout(Duration::from_secs(30), held.notified())
        .await
        .unwrap();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let current = children(&s).await?.remove(0);
    assert_eq!(
        current["terminal"], false,
        "an ending card cannot claim completion yet"
    );
    s.agent.kill9()?;
    release.notify_one();
    script.release.notify_one();
    s.gw = s.agent.start_again().await?;
    let ended = wait_result(&s, relation, "cancelled").await?;
    assert_closed(&db, ended["session_id"].as_str().unwrap());
    let (results, reports): (i64, i64) = db.query_row(
        "SELECT (SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1),
                (SELECT count(*) FROM btcc_subsession_outbox WHERE relation_id=?1 AND status='delivered')",
        [relation], |r| Ok((r.get(0)?,r.get(1)?)),
    )?;
    assert_eq!((results, reports), (1, 1), "one terminal result and one parent report");
    s.finish().await?;
    server.abort();
    barrier.abort();
    Ok(())
}
