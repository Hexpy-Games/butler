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

#[tokio::test]
async fn deleting_a_computer_keeps_conversations_it_never_sent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const OFFLINE: &str = "Finish this turn while the main is disconnected.";
    let (mut d, script, server, authority, chat) =
        remote_chat_on("REMOTE-TRANSCRIPTS-DELETE", "full_access", true).await?;
    script.rounds.lock().unwrap().insert(
        OFFLINE.into(),
        vec![call(
            "wait-for-delete-gate",
            "run_command",
            &json!({
                "command": "while [ ! -f transcript-delete-gate ]; do sleep 0.1; done",
                "summary": "Wait for the gate",
            }),
        )],
    );
    let turn = d.s.gw.say_turn(&chat, OFFLINE).await?;
    let connection = format!("/computers/{}/connection", d.id);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let reply = d.api.send(Method::GET, &connection, None, &[]).await?;
        assert_eq!(reply.status, 200, "{reply:?}");
        if reply.data()["state"] == "connected" {
            break;
        }
        assert!(Instant::now() < deadline, "{reply:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    d.sshd.drop_connections()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let reply = d.api.send(Method::GET, &connection, None, &[]).await?;
        assert_eq!(reply.status, 200, "{reply:?}");
        if reply.data()["state"] == "unreachable" && reply.data()["error"] == "ssh_unreachable" {
            break;
        }
        assert!(Instant::now() < deadline, "{reply:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    fs::write(d.remote.0.home.join("work/transcript-delete-gate"), b"")?;
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
    let path = format!("/computers/{}", d.id);
    let removed = d.api.send(Method::DELETE, &path, None, &[]).await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert_eq!(
        removed.data(),
        &json!({"deleted": true, "remote_cleaned": true})
    );
    let db = butler_platform::sqlite::open_with_flags(
        d.s.sandbox.data.join("runtime/conversation-store.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let gateway = format!("computer:{}", d.id);
    let present: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation_bindings b
         JOIN conversation_messages m ON m.session_id=b.conversation_session_id
         JOIN conversation_parts p ON p.message_id=m.id
         WHERE b.gateway=?1 AND json_extract(p.content_json,'$.text')=?2)",
        [gateway.as_str(), OFFLINE],
        |row| row.get(0),
    )?;
    assert!(present, "missing imported text: {OFFLINE}");
    assert!(!d.remote.0.home.join(".butler-remote").exists());
    drop(db);
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

#[tokio::test]
async fn delete_refuses_when_the_final_pull_fails() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let (d, _, server, authority, _) =
        remote_chat_on("REMOTE-TRANSCRIPTS-DELETE-FAILED", "full_access", true).await?;
    let cursor =
        d.s.sandbox
            .data
            .join(format!("config/computers/{}.transcripts.json", d.id));
    let deadline = Instant::now() + Duration::from_secs(60);
    while !cursor.exists() {
        assert!(
            Instant::now() < deadline,
            "background pull did not write its cursor"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    fs::write(cursor, br#"{"version":2}"#)?;
    let path = format!("/computers/{}", d.id);
    let refused = d.api.send(Method::DELETE, &path, None, &[]).await?;
    assert_eq!(refused.status, 409, "{refused:?}");
    assert_eq!(refused.error_code(), Some("computer_not_synced"));
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"][0]["id"], d.id);
    assert!(d.remote.0.home.join(".butler-remote").exists());
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

#[tokio::test]
async fn unreachable_computer_needs_force() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let (mut d, _, server, authority, _) =
        remote_chat_on("REMOTE-TRANSCRIPTS-DELETE-UNREACHABLE", "full_access", true).await?;
    d.sshd.drop_connections()?;
    let path = format!("/computers/{}", d.id);
    let refused = d.api.send(Method::DELETE, &path, None, &[]).await?;
    assert_eq!(refused.status, 409, "{refused:?}");
    assert_eq!(refused.error_code(), Some("computer_unreachable"));
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"][0]["id"], d.id);
    let forced = d
        .api
        .send(Method::DELETE, &format!("{path}?force=true"), None, &[])
        .await?;
    assert_eq!(forced.status, 200, "{forced:?}");
    assert_eq!(
        forced.data(),
        &json!({"deleted": true, "remote_cleaned": false})
    );
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"], json!([]));
    assert!(d.remote.0.home.join(".butler-remote").exists());
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

#[tokio::test]
async fn deleted_computer_conversation_opens_read_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ASK: &str = "Read this after removing the computer.";
    let (d, _, server, authority, chat) =
        remote_chat_on("REMOTE-READ-REMOVED", "full_access", true).await?;
    let turn = d.s.gw.say_turn(&chat, ASK).await?;
    wait_imported_turn(&d, &turn).await?;
    let removed = d
        .api
        .send(Method::DELETE, &format!("/computers/{}", d.id), None, &[])
        .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert_removed_conversation(&d, &chat, ASK).await?;
    drop((d.remote, d.sshd, d.files, server, authority));
    d.s.finish().await
}

#[tokio::test]
async fn force_deleted_computer_keeps_imported_conversations() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ASK: &str = "Read this after losing the computer.";
    let (mut d, _, server, authority, chat) =
        remote_chat_on("REMOTE-READ-FORCE-REMOVED", "full_access", true).await?;
    let turn = d.s.gw.say_turn(&chat, ASK).await?;
    wait_imported_turn(&d, &turn).await?;
    d.sshd.drop_connections()?;
    let removed = d
        .api
        .send(
            Method::DELETE,
            &format!("/computers/{}?force=true", d.id),
            None,
            &[],
        )
        .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert_eq!(removed.data()["remote_cleaned"], false);
    assert_removed_conversation(&d, &chat, ASK).await?;
    drop((d.remote, d.sshd, d.files, server, authority));
    d.s.finish().await
}

#[tokio::test]
async fn delete_refuses_while_a_turn_runs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ASK: &str = "Wait for the gate before answering.";
    let (d, script, server, authority, chat) =
        remote_chat_on("REMOTE-BUSY-DELETE", "full_access", true).await?;
    script.rounds.lock().unwrap().insert(
        ASK.into(),
        vec![call("delete-busy", "run_command", &json!({
            "command": "touch delete-busy-started; while [ ! -f delete-busy-release ]; do sleep 0.1; done",
            "summary": "Wait for the gate"
        }))],
    );
    let turn = d.s.gw.say_turn(&chat, ASK).await?;
    let work = d.remote.0.home.join("work");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !work.join("delete-busy-started").exists() {
        assert!(Instant::now() < deadline, "command did not reach the gate");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let path = format!("/computers/{}", d.id);
    let refused = d.api.send(Method::DELETE, &path, None, &[]).await?;
    assert_eq!(refused.status, 409, "{refused:?}");
    assert_eq!(refused.error_code(), Some("computer_busy"));
    let listed = d.api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"][0]["id"], d.id);
    fs::write(work.join("delete-busy-release"), b"")?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let removed = d.api.send(Method::DELETE, &path, None, &[]).await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert_removed_conversation(&d, &chat, ASK).await?;
    drop((d.remote, d.sshd, d.files, server, authority));
    d.s.finish().await
}

async fn wait_imported_turn(d: &Deployed, turn: &str) -> Result<(), HarnessError> {
    let cursor =
        d.s.sandbox
            .data
            .join(format!("config/computers/{}.transcripts.json", d.id));
    let deadline = Instant::now() + Duration::from_secs(90);
    while !cursor.exists() {
        assert!(Instant::now() < deadline, "transcript cursor is missing");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let db = butler_platform::sqlite::open_with_flags(
        d.s.sandbox.data.join("runtime/conversation-store.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    loop {
        let imported: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE id=?1)",
            [turn],
            |row| row.get(0),
        )?;
        if imported {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "turn was not imported");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn assert_removed_conversation(
    d: &Deployed,
    chat: &str,
    text: &str,
) -> Result<(), HarnessError> {
    let path = format!("/session-view?session_id={chat}");
    let view = d.s.gw.get(&path).await?;
    assert_eq!(view.status, 200, "{view:?}");
    assert_eq!(view.data()["latest_turn"]["state"], "delivered");
    let messages = &view.data()["messages"];
    assert_eq!(messages.as_array().map(Vec::len), Some(2));
    assert_eq!(messages[0]["text"], text);
    assert_eq!(messages[1]["text"], "Checked.");
    let listed = d.s.gw.get(&format!("/messages?chat_id={chat}")).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(&listed.data()["messages"], messages);
    let refused = d
        .api
        .send(
            Method::POST,
            "/messages",
            Some(json!({"chat_id": chat, "text": "Write again"})),
            &[],
        )
        .await?;
    assert_eq!(refused.status, 409, "{refused:?}");
    assert_eq!(refused.error_code(), Some("computer_removed"));
    let db = butler_platform::sqlite::open_with_flags(
        d.s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let counts = || {
        db.query_row(
        "SELECT (SELECT COUNT(*) FROM turns WHERE chat_id=?1), (SELECT COUNT(*) FROM messages WHERE chat_id=?1)",
        [chat], |row| Ok((row.get::<_, usize>(0)?, row.get::<_, usize>(1)?)),
    )
    };
    assert_eq!(counts()?, (1, 2));
    let again = d.s.gw.get(&path).await?;
    assert_eq!(again.status, 200, "{again:?}");
    assert_eq!(counts()?, (1, 2));
    Ok(())
}
