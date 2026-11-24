use super::super::{
    memory_fixture::settle,
    memory_reset_support::{local_model, profile_server},
    memory_wiring_more::support::graph,
};
use super::*;
use butler_platform::sqlite;
use rusqlite::{OpenFlags, OptionalExtension};

#[tokio::test]
async fn computer_memory_reset_keeps_the_conversations_and_forgets_their_memory()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ONLINE: &str = "Remember quince-remote-4417 from the computer.";
    let (mut d, _script, server, authority, chat) =
        remote_chat_on("REMOTE-MEMORY-RESET", "full_access", true).await?;
    let path = format!("/computers/{}/connection", d.id);
    let connection = async || d.api.send(Method::GET, &path, None, &[]).await;
    let wait_state =
        async |expected: &str, error: Option<&str>, seconds: u64| -> Result<(), HarnessError> {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            loop {
                let reply = connection().await?;
                assert_eq!(reply.status, 200, "{reply:?}");
                if reply.data()["state"] == expected && reply.data()["error"].as_str() == error {
                    return Ok(());
                }
                assert!(Instant::now() < deadline, "expected {expected}: {reply:?}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
    let (base, profile) = profile_server().await?;
    local_model(&d.s, &base).await?;
    let turn = d.s.gw.say_turn(&chat, ONLINE).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");

    let path = format!("/computers/{}/reconnect", d.id);
    let reconnect = d.api.send(Method::POST, &path, None, &[]).await?;
    assert_eq!(reconnect.status, 200, "{reconnect:?}");
    let db = sqlite::open_with_flags(
        d.s.sandbox.data.join("runtime/conversation-store.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let gateway = format!("computer:{}", d.id);
    let deadline = Instant::now() + Duration::from_secs(60);
    let session_id: String = loop {
        if let Some(session) = db.query_row(
            "SELECT t.session_id FROM conversation_turns t JOIN conversation_bindings b \
             ON b.conversation_session_id=t.session_id WHERE b.gateway=?1 GROUP BY t.session_id HAVING COUNT(*)=1",
            [&gateway], |row| row.get(0),
        ).optional()? {
            break session;
        }
        assert!(Instant::now() < deadline, "expected one imported turn");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    wait_state("idle", None, 30).await?;

    let chunks = |data: &Path| -> Result<u64, HarnessError> {
        let db = sqlite::open_with_flags(graph(data), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(db.query_row(
            "SELECT COUNT(*) FROM memory_chunks WHERE conversation_session_id=?1",
            [&session_id],
            |row| row.get(0),
        )?)
    };
    settle(&d.s.sandbox.data).await?;
    assert!(
        chunks(&d.s.sandbox.data)? > 0,
        "no memory chunks for imported session {session_id}"
    );

    let inventory = d.s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(inventory.status, 200, "{}", inventory.text);
    let id = uuid::Uuid::new_v4().to_string();
    let accepted =
        d.s.gw
            .post(
                &format!("/memory/reset/computers/{}", d.id),
                json!({"operation_id":id,"inventory_revision":inventory.data()["revision"]}),
            )
            .await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    assert_eq!(wait_reset(&d.s, &id).await?["kind"], "computer_memory");
    assert_eq!(chunks(&d.s.sandbox.data)?, 0);
    let turns: u64 = db.query_row(
        "SELECT COUNT(*) FROM conversation_turns WHERE session_id=?1",
        [&session_id],
        |row| row.get(0),
    )?;
    assert_eq!(turns, 1);
    drop(db);

    d.s.agent.terminate().await?;
    d.s.gw = d.s.agent.start_again().await?;
    settle(&d.s.sandbox.data).await?;
    assert_eq!(chunks(&d.s.sandbox.data)?, 0);
    profile.abort();
    let Deployed {
        s,
        remote,
        sshd,
        files,
        ..
    } = d;
    drop((remote, sshd, files, server, authority));
    s.finish().await
}

#[expect(clippy::expect_used, reason = "E2E assertion that the reset completes")]
async fn wait_reset(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(reply.data()["phase"], "failed", "{}", reply.text);
            if reply.data()["phase"] == "complete" {
                return Ok(reply.data().clone());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reset completion")
}
