//! Terminal cards close their execution authority before any follow-up starts.
use super::*;

#[tokio::test]
async fn failed_delegation_followup_has_new_card_and_closed_runtime() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    followup(false, true).await
}

pub(super) fn assert_closed(s: &Scenario, child: &Value) {
    let session = child["session_id"].as_str().unwrap();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    assert_eq!(child["terminal"], true, "{child}");
    assert!(butler_turn::btcc::storage::terminal_card_invariant(&db, session).unwrap());
    let open: i64 = db.query_row(
        "SELECT count(*) FROM btcc_turns WHERE session_id=?1 AND semantic_state IN ('admitted','delivery_committed')",
        [session], |row| row.get(0),
    ).unwrap();
    assert_eq!(open, 0, "terminal card must have no active turn");
    let work: i64 = db.query_row(
        "SELECT count(*) FROM btcc_guided_works WHERE session_id=?1 AND status IN ('open','blocked')",
        [session], |row| row.get(0),
    ).unwrap();
    assert_eq!(work, 0, "terminal card must have no open Work/Task");
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
    let pending: i64 = db.query_row("SELECT count(*) FROM btcc_subsession_endings", [], |r| {
        r.get(0)
    })?;
    assert_eq!(
        pending, 1,
        "closeout intent survives before terminal publication"
    );
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
    assert_closed(&s, &ended);
    let (pending, results): (i64, i64) = db.query_row("SELECT (SELECT count(*) FROM btcc_subsession_endings),(SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1)", [relation], |r| Ok((r.get(0)?,r.get(1)?)))?;
    assert_eq!((pending, results), (0, 1), "recovery finishes exactly once");
    s.finish().await?;
    server.abort();
    barrier.abort();
    Ok(())
}
