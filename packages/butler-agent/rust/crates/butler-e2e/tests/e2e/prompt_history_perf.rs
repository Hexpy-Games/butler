//! Heavy prompt history stays in the opt-in perf tier.
use super::*;
use std::time::Instant;

#[tokio::test]
async fn perf_owner_scale_history_assembly_and_idle_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if std::env::var("BUTLER_E2E_PERF").as_deref() != Ok("1") {
        return Ok(());
    }
    let (url, stub, server) = provider::start(false).await?;
    let setup = Setup::new("PROMPT-OWNER-SCALE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .env("BUTLER_E2E_STARTUP_TRACE", "1");
    super::super::perf_turn::require_release_agent(&setup)?;
    let mut s = setup.start().await?;
    s.turn("general", "warm owner-scale fixture").await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("runtime/conversation-store.sqlite");
    seed(&path)?;
    let bytes = std::fs::metadata(&path)?.len();
    assert!(bytes >= 2_600_000_000);
    s.gw = s.agent.start_again().await?;
    let request_index = stub.requests.lock().unwrap().len();
    let started = Instant::now();
    let (_, turn) = s.turn("general", "owner-scale latest request").await?;
    assert_eq!(turn["state"], "delivered");
    let request = stub.requests.lock().unwrap()[request_index].clone();
    for index in 996..1000 {
        assert!(source(&request).contains(&format!("user: owner history request {index}")));
        assert!(source(&request).contains(&format!("butler: owner history reply {index}")));
    }
    let text = source(&request);
    assert!(
        text.find("owner history request 997").unwrap()
            < text.find("owner history request 999").unwrap()
    );
    let db = Connection::open(&path)?;
    let messages: u64 = db.query_row("SELECT COUNT(*) FROM conversation_messages", [], |row| {
        row.get(0)
    })?;
    assert_eq!(messages, 4604);
    let dropped: u64 = db.query_row(
        "SELECT COUNT(*) FROM conversation_messages WHERE compacted_by_summary_id IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(dropped, 0, "prompt assembly must not compact any message");
    assert_eq!(
        db.query_row::<u64, _, _>("SELECT COUNT(*) FROM conversation_summaries", [], |r| r
            .get(0))?,
        0
    );
    let mut recent = vec![
        (
            "owner history request 997".to_owned(),
            "owner history reply 997".to_owned(),
        ),
        (
            "owner history request 998".to_owned(),
            "owner history reply 998".to_owned(),
        ),
        (
            "owner history request 999".to_owned(),
            "owner history reply 999".to_owned(),
        ),
        ("owner-scale latest request".to_owned(), "once".to_owned()),
    ];
    for index in 0..20 {
        let start = stub.requests.lock().unwrap().len();
        s.turn("general", &format!("steady history request {index}"))
            .await?;
        let requests = stub.requests.lock().unwrap();
        let text = source(&requests[start]);
        let mut previous = 0;
        for (ask, reply) in &recent {
            let start = text.find(&format!("user: {ask}")).unwrap();
            assert!(start >= previous, "latest four turns remain ordered");
            let tail = &text[start..];
            let end = tail[1..].find("\nturn ").map_or(tail.len(), |i| i + 1);
            assert!(
                tail[..end].contains(&format!("butler: {reply}")),
                "latest final reply remains complete"
            );
            previous = start;
        }
        recent.remove(0);
        recent.push((format!("steady history request {index}"), "once".into()));
    }
    let log = std::fs::read_to_string(s.sandbox.logs.join("agent-2.log"))?;
    let elapsed: Vec<u64> = log
        .lines()
        .filter_map(|line| line.split("[history-projection] elapsed_us=").nth(1))
        .map(|line| line.split_whitespace().next().unwrap().parse().unwrap())
        .collect();
    assert_eq!(elapsed.len(), 21);
    let first = elapsed[0];
    let mut steady = elapsed[1..].to_vec();
    steady.sort_unstable();
    let median = u64::midpoint(steady[9], steady[10]);
    let p95 = steady[18];
    eprintln!(
        "PROMPT_OWNER database_bytes={bytes} first_request_us={first} steady_turns=20 median_us={median} p95_us={p95} delivery_ms={} index_build_us=0 index_bytes_written=0 extra_insert_us=0",
        started.elapsed().as_millis()
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    let before: u64 = db.query_row("PRAGMA data_version", [], |row| row.get(0))?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let after: u64 = db.query_row("PRAGMA data_version", [], |row| row.get(0))?;
    assert_eq!(before, after, "idle canonical history writes");
    eprintln!("PROMPT_OWNER idle_writes=0");
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_micros(p95),
        Duration::from_millis(20),
        "owner-scale history assembly"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn seed(path: &std::path::Path) -> Result<(), HarnessError> {
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let session: String =
        tx.query_row("SELECT id FROM conversation_sessions LIMIT 1", [], |row| {
            row.get(0)
        })?;
    assert_eq!(
        tx.query_row::<u64, _, _>("SELECT COUNT(*) FROM conversation_summaries", [], |row| row
            .get(0))?,
        0
    );
    let completed_at: String = tx.query_row(
        "SELECT completed_at FROM conversation_turns LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    for index in 0..1000 {
        let turn = format!("ct_owner_{index}");
        tx.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) VALUES(?1,?2,?3,'user','complete','2026-01-01T00:00:00Z',?4)",rusqlite::params![turn,session,index+2,completed_at])?;
        for (offset, role, text) in [
            (0, "user", format!("owner history request {index}")),
            (1, "assistant", format!("owner history reply {index}")),
        ] {
            message(
                &tx,
                &session,
                &turn,
                index * 2 + offset + 3,
                role,
                &json!({"text":text}).to_string(),
                "text",
            )?;
        }
    }
    tx.execute("INSERT INTO conversation_sessions VALUES('cs_padding',NULL,NULL,'fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','complete',6)",[])?;
    tx.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) VALUES('ct_padding','cs_padding',1,'user','complete','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[])?;
    let output = json!({"ok":true,"output":"x".repeat(1_000_000)}).to_string();
    for index in 0..2600 {
        message(
            &tx,
            "cs_padding",
            "ct_padding",
            index + 1,
            "tool",
            &output,
            "tool_result",
        )?;
    }
    tx.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}

fn message(
    db: &Connection,
    session: &str,
    turn: &str,
    seq: u64,
    role: &str,
    content: &str,
    kind: &str,
) -> Result<(), HarnessError> {
    let id = format!("cm_{session}_{seq}");
    db.execute("INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES(?1,?2,?3,?4,?5,'complete','user','imported','2026-01-01T00:00:00Z')",rusqlite::params![id,session,turn,seq,role])?;
    db.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,?3,?4,'complete')",rusqlite::params![format!("cp_{session}_{seq}"),id,kind,content])?;
    Ok(())
}
