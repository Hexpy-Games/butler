use super::*;

#[tokio::test]
async fn remote_conversations_reach_the_main_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ONLINE: &str = "Remember plum-remote-6120 from the computer.";
    const OFFLINE: &str = "Keep going while the main is away.";
    const SEARCH: &str = "Search all chats for the note from the computer.";
    let (mut d, script, server, authority, chat) =
        remote_chat_on("REMOTE-TRANSCRIPTS", "full_access", true).await?;
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
    let turn = d.s.gw.say_turn(&chat, ONLINE).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");

    let gate = |name: &str| {
        call(
            name,
            "run_command",
            &json!({"command": format!("while [ ! -f {name} ]; do sleep 0.1; done"), "summary": "Wait for the gate"}),
        )
    };
    script
        .rounds
        .lock()
        .unwrap()
        .insert(OFFLINE.into(), vec![gate("transcript-gate-1")]);
    let turn = d.s.gw.say_turn(&chat, OFFLINE).await?;
    wait_state("connected", None, 30).await?;
    d.sshd.drop_connections()?;
    wait_state("unreachable", Some("ssh_unreachable"), 60).await?;
    fs::write(d.remote.0.home.join("work/transcript-gate-1"), b"")?;
    let db = butler_platform::sqlite::open_with_flags(
        d.remote.0.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let state: String =
            db.query_row("SELECT state FROM turns WHERE id=?1", [&turn], |row| {
                row.get(0)
            })?;
        if state == "delivered" {
            break;
        }
        assert!(Instant::now() < deadline, "remote turn stayed {state}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drop(db);

    d.sshd.restart()?;
    let path = format!("/computers/{}/reconnect", d.id);
    let reconnect = d.api.send(Method::POST, &path, None, &[]).await?;
    assert_eq!(reconnect.status, 200, "{reconnect:?}");
    let db = butler_platform::sqlite::open_with_flags(
        d.s.sandbox.data.join("runtime/conversation-store.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let gateway = format!("computer:{}", d.id);
    let count_turns = "SELECT COUNT(*) FROM conversation_turns t JOIN conversation_bindings b \
                       ON b.conversation_session_id=t.session_id WHERE b.gateway=?1";
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let count: u64 = db.query_row(count_turns, [&gateway], |r| r.get(0))?;
        if count == 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "expected two imported turns, got {count}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let bindings: Vec<String> = db
        .prepare("SELECT conversation_session_id FROM conversation_bindings WHERE gateway=?1")?
        .query_map([&gateway], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    assert_eq!(bindings.len(), 1);
    let session_id = &bindings[0];
    for expected in [ONLINE, OFFLINE] {
        let present: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_messages m JOIN conversation_parts p ON p.message_id=m.id \
             WHERE m.session_id=?1 AND json_extract(p.content_json,'$.text')=?2)",
            [session_id.as_str(), expected], |r| r.get(0),
        )?;
        assert!(present, "missing imported text: {expected}");
    }
    let reconnect = d.api.send(Method::POST, &path, None, &[]).await?;
    assert_eq!(reconnect.status, 200, "{reconnect:?}");
    wait_state("idle", None, 30).await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let turns: u64 = db.query_row(count_turns, [&gateway], |r| r.get(0))?;
        assert_eq!(turns, 2);
        let unique: bool = db.query_row(
            "SELECT COUNT(*) = COUNT(DISTINCT id) FROM conversation_messages WHERE session_id=?1",
            [session_id],
            |r| r.get(0),
        )?;
        assert!(unique);
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drop(db);
    script.rounds.lock().unwrap().insert(SEARCH.into(), vec![call("q", "query_memory",
        &json!({"terms":["plum-remote-6120"],"match_mode":"any","scope":"all_user_sessions","limit":5}))]);
    let turn = d.s.gw.say_turn("general", SEARCH).await?;
    let terminal =
        d.s.gw
            .wait_terminal("general", &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let found = tool_output(&script.requests_for(SEARCH), "q").unwrap();
    assert!(
        found.contains("plum-remote-6120") && found.contains(r#""ok":true"#),
        "{found}"
    );
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
