//! A remote session reads the main's memory: its instructions in the prompt,
//! and searches the main answers while connected.
use super::{
    access_tiers::stub::call, computer_account::Deployed, remote_sessions::remote_chat_on,
};
use butler_e2e::e2e::{HarnessError, gateway::turn_state};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

const RULE: &str = "Mention quince-copy-4182 in every answer.";
const SAVE: &str = "Remember this instruction for every chat.";

#[tokio::test]
async fn remote_session_prompt_carries_the_main_instructions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ASK: &str = "Say hello from the computer.";
    let (d, script, server, authority, chat) =
        remote_chat_on("REMOTE-MEMORY-COPY", "full_access", true).await?;
    script.wait_for_tools.store(true, Ordering::Relaxed);
    script.rounds.lock().unwrap().insert(
        SAVE.into(),
        vec![call(
            "m",
            "update_explicit_memory",
            &json!({"kind":"instruction","text":RULE,"source":SAVE}),
        )],
    );
    let turn = d.s.gw.say_turn("general", SAVE).await?;
    let terminal =
        d.s.gw
            .wait_terminal("general", &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let listed = d.s.gw.get("/memory/instructions").await?;
    assert!(
        listed.data()["instructions"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["text"] == RULE)),
        "{}",
        listed.text
    );
    let start = d
        .api
        .send(
            Method::POST,
            &format!("/computers/{}/start", d.id),
            None,
            &[],
        )
        .await?;
    assert_eq!(start.status, 200, "{start:?}");
    let turn = d.s.gw.say_turn(&chat, ASK).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let requests = script.requests_for(ASK);
    assert!(
        requests
            .first()
            .is_some_and(|request| request.to_string().contains(RULE)),
        "the remote prompt lacks the main's instruction"
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

fn tool_output(requests: &[Value], call_id: &str) -> Option<String> {
    requests
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
        .and_then(|item| item["output"].as_str().map(str::to_owned))
}

#[tokio::test]
async fn remote_session_reads_the_main_memory_only_while_connected() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const NOTE: &str = "Keep in mind that apricot-main-7315 grows on the main.";
    const CONNECTED: &str = "Search the main memory now.";
    const OFFLINE: &str = "Search the main memory while it is away.";
    let (mut d, script, server, authority, chat) =
        remote_chat_on("REMOTE-MEMORY-READ", "full_access", true).await?;
    let search = json!({"terms":["apricot-main-7315"],"match_mode":"any","scope":"all_user_sessions","limit":5});
    let gate = |name: &str| {
        call(
            name,
            "run_command",
            &json!({"command": format!("while [ ! -f {name} ]; do sleep 0.1; done"), "summary": "Wait for the gate"}),
        )
    };
    script.rounds.lock().unwrap().insert(
        CONNECTED.into(),
        vec![
            gate("memory-gate-1"),
            call("q1", "query_memory", &search),
            gate("memory-gate-3"),
        ],
    );
    script.rounds.lock().unwrap().insert(
        OFFLINE.into(),
        vec![gate("memory-gate-2"), call("q2", "query_memory", &search)],
    );
    let turn = d.s.gw.say_turn("general", NOTE).await?;
    let terminal =
        d.s.gw
            .wait_terminal("general", &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
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
    let turn = d.s.gw.say_turn(&chat, CONNECTED).await?;
    wait_state("connected", None, 30).await?;
    fs::write(d.remote.0.home.join("work/memory-gate-1"), b"")?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let found = loop {
        if let Some(found) = tool_output(&script.requests_for(CONNECTED), "q1") {
            break found;
        }
        assert!(Instant::now() < deadline, "missing connected query output");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(
        found.contains("grows on the main") && found.contains(r#""ok":true"#),
        "{found}"
    );
    let read_args = serde_json::from_str::<Value>(&found)
        .unwrap()
        .pointer("/output/results/0/read_args")
        .cloned()
        .unwrap();
    script
        .rounds
        .lock()
        .unwrap()
        .get_mut(CONNECTED)
        .unwrap()
        .push(call("r1", "read_conversation_session", &read_args));
    fs::write(d.remote.0.home.join("work/memory-gate-3"), b"")?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let source = tool_output(&script.requests_for(CONNECTED), "r1").unwrap();
    assert!(
        source.contains("grows on the main") && source.contains(r#""mode":"source""#),
        "{source}"
    );

    wait_state("idle", None, 30).await?;
    let turn = d.s.gw.say_turn(&chat, OFFLINE).await?;
    wait_state("connected", None, 30).await?;
    d.sshd.drop_connections()?;
    wait_state("unreachable", Some("ssh_unreachable"), 60).await?;
    fs::write(d.remote.0.home.join("work/memory-gate-2"), b"")?;
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
    let offline = tool_output(&script.requests_for(OFFLINE), "q2").unwrap();
    assert!(
        offline.contains("main_not_connected")
            && offline.contains("Not connected to the main device."),
        "{offline}"
    );
    d.sshd.restart()?;
    let reconnect = d
        .api
        .send(
            Method::POST,
            &format!("/computers/{}/reconnect", d.id),
            None,
            &[],
        )
        .await?;
    assert_eq!(reconnect.status, 200, "{reconnect:?}");
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    wait_state("idle", None, 30).await?;
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
