//! BTCC operations stay outside the canonical conversation transcript.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::{Gateway, turn_state},
    scenario::{Access, Setup},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Duration};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Step {
    pub call_id: String,
    pub ord: u32,
    pub name: Option<String>,
    pub label: Option<String>,
    pub input: Option<String>,
    pub status: Option<String>,
    pub started: String,
    pub completed: Option<String>,
}

pub(super) fn stored_steps(data: &Path, turn: &str) -> Result<Vec<Step>, HarnessError> {
    let db = Connection::open_with_flags(
        data.join("runtime/conversation-store.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok(db.prepare(
        "SELECT tool_call_id, ord, safe_tool_name, safe_label, safe_input_label, status,
                started_at, completed_at FROM conversation_tool_steps WHERE turn_id=?1 ORDER BY ord",
    )?.query_map([turn], |row| Ok(Step {
        call_id: row.get(0)?,
        ord: row.get(1)?,
        name: row.get(2)?,
        label: row.get(3)?,
        input: row.get(4)?,
        status: row.get(5)?,
        started: row.get(6)?,
        completed: row.get(7)?,
    }))?.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn live_call_ids(data: &Path, turn: &str) -> Result<HashSet<String>, HarnessError> {
    let db = Connection::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok(db
        .prepare(
            "SELECT DISTINCT event_json ->> '$.payload.toolCallId' FROM btcc_progress_events
         WHERE turn_id=?1 AND event_json ->> '$.payload.bridgePhase'='btcc_operation'",
        )?
        .query_map([turn], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

pub(super) async fn displayed_steps(
    gateway: &Gateway,
    chat: &str,
    turn: &str,
) -> Result<Vec<Value>, HarnessError> {
    let reply = gateway.get(&format!("/messages?chat_id={chat}")).await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    Ok(reply.data()["turn_progress"][turn]["safe_progress_rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["bridge_phase"] == "btcc_operation")
        .map(|row| {
            json!([
                row["safe_tool_name"],
                row["safe_input_label"],
                row["state"],
                row["tool_call_id"]
            ])
        })
        .collect())
}

#[tokio::test]
async fn btcc_tool_steps_keep_live_order_and_leave_message_sequences_alone()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let secret = butler_e2e::e2e::nonce();
    let setup = Setup::new("TOOL-STEPS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .placeholder("NONCE", &secret);
    std::fs::write(
        setup.sandbox.chat_folder("general")?.join("notes.txt"),
        &secret,
    )?;
    let s = setup.start().await?;
    let (turn, outcome) = s
        .turn(
            "general",
            "Read the file notes.txt in your workspace and tell me the secret word.",
        )
        .await?;
    assert_eq!(turn_state(&outcome), "delivered");
    let steps = stored_steps(&s.sandbox.data, &turn)?;
    assert_eq!(steps.len(), 1);
    let step = &steps[0];
    assert_eq!(step.ord, 0);
    assert_eq!(step.name.as_deref(), Some("read_file"));
    assert_eq!(step.label.as_deref(), Some("read_file"));
    assert_eq!(step.input.as_deref(), Some("notes.txt"));
    assert_eq!(step.status.as_deref(), Some("completed"));
    assert!(!format!("{step:?}").contains(&secret));
    let tool_shape = message_shape(&s.sandbox.data, &turn)?;
    s.finish().await?;

    let (url, script, server) = super::access_tiers::stub::start().await?;
    let setup = Setup::new("TOOL-STEPS-BATCH")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.chat_folder("general")?;
    let list = |id, root| super::access_tiers::stub::call(id, "list_files", &json!({"root": root}));
    let ask = "List the contents of both folders.";
    script.rounds.lock().unwrap().insert(
        ask.into(),
        vec![json!([
            list("missing", folder.join("missing").display().to_string()),
            list("denied", folder.display().to_string()),
        ])],
    );
    let s = setup.start().await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let (text_turn, outcome) = s.turn("general", "Say hello.").await?;
    assert_eq!(turn_state(&outcome), "delivered");
    assert_eq!(message_shape(&s.sandbox.data, &text_turn)?, tool_shape);
    assert_eq!(
        tool_shape,
        [("user".to_owned(), 0), ("assistant".to_owned(), 1)]
    );

    let turn = s.gw.say_turn("general", ask).await?;
    let paused =
        s.gw.wait_turn(
            "general",
            &turn,
            &["waiting_for_form", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&paused), "waiting_for_form");
    let cards = s.gw.approval_requests("general").await?;
    assert_eq!(cards.len(), 2);
    for card in cards {
        let action = if card["approval"].to_string().contains("missing") {
            "allow"
        } else {
            "deny"
        };
        let reference = card["request_ref"].as_str().unwrap();
        let response =
            s.gw.post(
                &format!("/authority-requests/{reference}/{action}?session_id=general"),
                if action == "allow" {
                    json!({"scope":"once"})
                } else {
                    json!({})
                },
            )
            .await?;
        assert_eq!(response.status, 202, "{response:?}");
    }
    let outcome =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&outcome), "delivered");
    let steps = stored_steps(&s.sandbox.data, &turn)?;
    let live = displayed_steps(&s.gw, "general", &turn).await?;
    assert_eq!(steps.len(), 2);
    assert_eq!(live.len(), steps.len());
    for (ord, (step, row)) in steps.iter().zip(live).enumerate() {
        assert_eq!(step.ord as usize, ord);
        assert_eq!(row[3], step.call_id);
        assert_eq!(step.name.as_deref(), Some("list_files"));
        assert_eq!(
            step.status.as_deref(),
            Some(if step.call_id == "missing" {
                "failed"
            } else {
                "cancelled"
            })
        );
    }
    server.abort();
    s.finish().await
}

fn message_shape(data: &Path, turn: &str) -> Result<Vec<(String, u64)>, HarnessError> {
    let db = Connection::open_with_flags(
        data.join("runtime/conversation-store.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    Ok(db.prepare(
        "SELECT role, seq - MIN(seq) OVER () FROM conversation_messages WHERE turn_id=?1 ORDER BY seq",
    )?.query_map([turn], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
}
