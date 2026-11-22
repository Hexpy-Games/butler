//! Remote turn continuity across a lost SSH connection and idle teardown.
use super::{
    access_tiers::stub::call,
    computer_account::{Deployed, socket},
};
use butler_e2e::e2e::{
    HarnessError,
    events::{LiveEvents, event_turn_id},
    gateway::turn_state,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

#[tokio::test]
async fn remote_turn_events_relay_only_while_the_turn_runs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const PROMPT: &str = "Wait for the remote gate.";
    let (mut d, script, server, authority, chat) =
        super::remote_sessions::remote_chat("REMOTE-LIVE", "full_access").await?;
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
    let disconnected = async |sshd: &butler_e2e::e2e::sshd::TestSshd| {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !sshd.connections().is_empty() {
            assert!(
                Instant::now() < deadline,
                "SSH connections survived the turn"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    wait_state("idle", None, 30).await?;
    disconnected(&d.sshd).await;
    let missing = d
        .api
        .send(Method::GET, "/computers/missing/connection", None, &[])
        .await?;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.error_code(), Some("computer_not_found"));
    let live = LiveEvents::subscribe(&d.s.gw, 0).await?;
    script.rounds.lock().unwrap().insert(PROMPT.into(), vec![json!([call("gate", "run_command", &json!({
        "command":"while [ ! -f gate ]; do sleep 0.1; done; echo released > after-gate.txt","summary":"Wait for the gate"
    }))])]);
    let turn = d.s.gw.say_turn(&chat, PROMPT).await?;
    let idless_turn = |e: &Value| e.get("id").is_none() && event_turn_id(e) == Some(&turn);
    live.wait_for(Duration::from_secs(30), idless_turn).await?;
    wait_state("connected", None, 30).await?;
    d.sshd.drop_connections()?;
    wait_state("unreachable", Some("ssh_unreachable"), 60).await?;
    let status = |e: &Value, state: &str| {
        e["type"] == "remote.connection_changed"
            && e["payload"]["computer_id"] == d.id
            && e["payload"]["state"] == state
    };
    live.wait_for(Duration::from_secs(30), |e| status(e, "unreachable"))
        .await?;
    fs::write(d.remote.0.home.join("work/gate"), b"")?;
    let db = butler_platform::sqlite::open_with_flags(
        d.remote.0.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let deadline = Instant::now() + Duration::from_secs(60);
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
    assert!(d.remote.0.home.join("work/after-gate.txt").is_file());
    let reply = connection().await?;
    assert_eq!(reply.status, 200);
    assert!(!matches!(
        reply.data()["state"].as_str(),
        Some("connected" | "idle")
    ));
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
    live.wait_for(Duration::from_secs(30), |e| {
        idless_turn(e)
            && e["type"] == "turn.state_changed"
            && (e["payload"]["turn"]["state"] == "delivered"
                || e["payload"]["state"] == "delivered")
    })
    .await?;
    let relevant = |event: &Value| {
        let kind = event["type"].as_str()?;
        (event_turn_id(event) == Some(&turn)
            && kind != "turn.thinking"
            && (kind.starts_with("turn.")
                || kind.starts_with("message.")
                || kind.starts_with("agent.turn_event")
                || kind == "progress.summary"))
            .then(|| (kind.to_owned(), event["payload"].clone()))
    };
    let mut cursor = 0;
    let mut remote_events = Vec::new();
    loop {
        let path = format!("/events?cursor={cursor}&limit=200");
        let (code, page) = socket(&d.remote.0, "GET", &path, None).await?;
        assert_eq!(code, 200);
        let events = page["data"]["events"].as_array().unwrap();
        let Some(last) = events.last() else { break };
        cursor = last["id"].as_u64().unwrap();
        remote_events.extend(events.iter().filter_map(relevant));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let main_events = loop {
        let events: Vec<_> = live
            .snapshot()
            .iter()
            .filter(|e| e.get("id").is_none())
            .filter_map(relevant)
            .collect();
        if events.len() >= remote_events.len() {
            break events;
        }
        assert!(
            Instant::now() < deadline,
            "received {} of {} events",
            events.len(),
            remote_events.len()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_ne!(remote_events.len(), 0, "remote turn had no durable events");
    assert_eq!(main_events[..remote_events.len()], remote_events);
    wait_state("idle", None, 30).await?;
    disconnected(&d.sshd).await;
    live.wait_for(Duration::from_secs(30), |e| status(e, "idle"))
        .await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered");
    assert!(
        d.s.gw
            .messages(&chat)
            .await?
            .iter()
            .any(|message| message["text"] == "Checked.")
    );
    assert_eq!(connection().await?.data()["state"], "idle");
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
