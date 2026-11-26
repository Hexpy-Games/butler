//! A remote session reads the main's memory: its instructions in the prompt,
//! and searches the main answers while connected.
mod reset;
mod tool_steps;
mod transcripts;

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

#[tokio::test]
async fn remote_instructions_wait_for_confirmation_on_the_main() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const KEEP: &str = "Mention fig-main-5521 in every answer.";
    const NEW: &str = "Answer in one line.";
    const CHANGED: &str = "Mention fig-remote-7731 in every answer.";
    const MAIN_CHANGED: &str = "Mention fig-main-9904 in every answer.";
    const OFFLINE: &str = "Save two instructions while the main is away.";
    const ASK: &str = "Say hello from the computer.";
    const CORRECT: &str = "Change the instruction on the main device.";
    let (mut d, script, server, authority, chat) =
        remote_chat_on("REMOTE-INSTR", "full_access", true).await?;
    script.wait_for_tools.store(true, Ordering::Relaxed);
    script.rounds.lock().unwrap().insert(
        SAVE.into(),
        vec![call(
            "k1",
            "update_explicit_memory",
            &json!({"kind":"instruction","text":KEEP,"source":SAVE}),
        )],
    );
    let turn = d.s.gw.say_turn("general", SAVE).await?;
    let terminal =
        d.s.gw
            .wait_terminal("general", &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    script.wait_for_tools.store(false, Ordering::Relaxed);
    let listed = d.s.gw.get("/memory/instructions").await?;
    let keep = listed.data()["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["text"] == KEEP)
        .unwrap();
    let handle = keep["handle"].as_str().unwrap();
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
    let gate = |name: &str| {
        call(
            name,
            "run_command",
            &json!({"command": format!("while [ ! -f {name} ]; do sleep 0.1; done"), "summary": "Wait for the gate"}),
        )
    };
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
    script.rounds.lock().unwrap().insert(
        OFFLINE.into(),
        vec![
            gate("instr-gate-1"),
            call(
                "n1",
                "update_explicit_memory",
                &json!({"kind":"instruction","text":NEW,"source":OFFLINE}),
            ),
            call(
                "c1",
                "update_explicit_memory",
                &json!({"kind":"instruction","text":CHANGED,"source":OFFLINE,"replaces":handle}),
            ),
        ],
    );
    let turn = d.s.gw.say_turn(&chat, OFFLINE).await?;
    wait_state("connected", None, 30).await?;
    d.sshd.drop_connections()?;
    wait_state("unreachable", Some("ssh_unreachable"), 60).await?;
    fs::write(d.remote.0.home.join("work/instr-gate-1"), b"")?;
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
    for id in ["n1", "c1"] {
        let output = tool_output(&script.requests_for(OFFLINE), id).unwrap();
        assert!(output.contains("awaiting_confirmation"), "{output}");
    }
    script.rounds.lock().unwrap().insert(
        CORRECT.into(),
        vec![call(
            "k2",
            "update_explicit_memory",
            &json!({"kind":"instruction","text":MAIN_CHANGED,"source":CORRECT,"replaces":handle}),
        )],
    );
    let turn = d.s.gw.say_turn("general", CORRECT).await?;
    let terminal =
        d.s.gw
            .wait_terminal("general", &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    d.sshd.restart()?;
    let path = format!("/computers/{}/reconnect", d.id);
    let reconnect = d.api.send(Method::POST, &path, None, &[]).await?;
    assert_eq!(reconnect.status, 200, "{reconnect:?}");
    let pending = "/memory/instructions/pending";
    let deadline = Instant::now() + Duration::from_secs(60);
    let listed = loop {
        let reply = d.s.gw.get(pending).await?;
        assert_eq!(reply.status, 200, "{reply:?}");
        if reply.data()["pending"]
            .as_array()
            .is_some_and(|items| items.len() == 2)
        {
            break reply;
        }
        assert!(
            Instant::now() < deadline,
            "expected two pending instructions: {reply:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let items = listed.data()["pending"].as_array().unwrap();
    let remember = items
        .iter()
        .find(|item| item["action"] == "remember")
        .unwrap();
    let replace = items
        .iter()
        .find(|item| item["action"] == "replace")
        .unwrap();
    assert_eq!(remember["text"], NEW);
    assert_eq!(remember["conflict"], false);
    assert_eq!(replace["text"], CHANGED);
    assert_eq!(replace["conflict"], true);
    assert_eq!(replace["current"]["text"], MAIN_CHANGED);
    assert_eq!(replace["target"]["text"], KEEP);
    let main = d.s.gw.get("/memory/instructions").await?;
    let rules = main.data()["instructions"].as_array().unwrap();
    assert!(rules.iter().any(|r| r["text"] == MAIN_CHANGED));
    assert!(
        !rules
            .iter()
            .any(|r| r["text"] == NEW || r["text"] == CHANGED)
    );

    let turn = d.s.gw.say_turn(&chat, ASK).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let prompt = script.requests_for(ASK).first().unwrap().to_string();
    assert!(prompt.contains(NEW) && prompt.contains(CHANGED) && !prompt.contains("fig-main-5521"));

    let apply =
        d.s.gw
            .post(
                &format!("{pending}/{}", remember["id"].as_str().unwrap()),
                json!({"decision":"apply"}),
            )
            .await?;
    assert_eq!(apply.status, 200, "{apply:?}");
    let main = d.s.gw.get("/memory/instructions").await?;
    assert!(
        main.data()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["text"] == NEW)
    );
    let path_replace = format!("{pending}/{}", replace["id"].as_str().unwrap());
    let stale =
        d.s.gw
            .post(&path_replace, json!({"decision":"apply"}))
            .await?;
    assert_eq!(stale.status, 409, "{stale:?}");
    assert_eq!(stale.error_code(), Some("instruction_changed"));
    let remaining = d.s.gw.get(pending).await?;
    assert!(
        remaining.data()["pending"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == replace["id"])
    );
    let discard =
        d.s.gw
            .post(&path_replace, json!({"decision":"discard"}))
            .await?;
    assert_eq!(discard.status, 200, "{discard:?}");
    assert_eq!(d.s.gw.get(pending).await?.data()["pending"], json!([]));
    let main = d.s.gw.get("/memory/instructions").await?;
    assert!(
        main.data()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["text"] == MAIN_CHANGED)
    );
    let reconnect = d.api.send(Method::POST, &path, None, &[]).await?;
    assert_eq!(reconnect.status, 200, "{reconnect:?}");
    wait_state("idle", None, 30).await?;
    assert_eq!(d.s.gw.get(pending).await?.data()["pending"], json!([]));
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
