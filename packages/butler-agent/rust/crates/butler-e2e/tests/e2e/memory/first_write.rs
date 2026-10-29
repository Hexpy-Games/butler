//! The first explicit write waits for fresh generation publication.
use super::super::memory_wiring_more::support;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Setup, accepted_turn_id},
};
use rusqlite::OptionalExtension;
use serde_json::json;
use std::{path::PathBuf, time::Duration};

const ASK: &str =
    "Remember this durable instruction: use short answers. Use update_explicit_memory.";
const RULE: &str = "Use short answers.";

#[tokio::test]
async fn mem_03_explicit_write_waits_for_first_generation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("MEM-01")?;
    let original = cassette.exchanges.len();
    support::add_call(
        &mut cassette,
        ASK,
        "update_explicit_memory",
        &json!({"kind":"instruction","text":RULE,"source":ASK}),
    );
    cassette.exchanges = cassette.exchanges.split_off(original);
    let s = Setup::new("MEM-03-FIRST-WRITE")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    s.provider()?.set_memory_responder(support::meaning);
    let descriptor = s
        .sandbox
        .data
        .join("cognition/memory/active-generation.json");
    assert!(!descriptor.exists(), "bootstrap ran despite hold");
    let turn_id = accepted_turn_id(&s.gw.say("general", ASK).await?)?;
    // Observe the product's durable tool receipt, including an already completed
    // failure so the unfixed path reports its result instead of timing out.
    let (status, result) = started_write(s.sandbox.data.clone(), turn_id.clone()).await;
    assert_ne!(
        status, "completed",
        "explicit write finished before publication: {result:?}"
    );
    assert!(!descriptor.exists(), "bootstrap ran before release");
    std::fs::write(
        s.sandbox.data.join("state/e2e-memory-bootstrap-release"),
        b"",
    )?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(90))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let result = support::result(&s, "general", &turn_id, "update_explicit_memory").await?;
    assert_eq!(result["ok"], true, "{result}");
    assert!(descriptor.exists(), "write finished without publication");
    let reply = s.gw.get("/memory/instructions").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let data = reply.data();
    let rules = data["instructions"].as_array().unwrap();
    assert_eq!(rules.len(), 1, "{data}");
    assert_eq!(rules[0]["text"], RULE, "{data}");
    s.finish().await
}

async fn started_write(data: PathBuf, turn: String) -> (String, Option<String>) {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let path = data.join("agent-runtime/btcc.sqlite");
            let turn = turn.clone();
            let row = tokio::task::spawn_blocking(move || {
                let db = rusqlite::Connection::open_with_flags(
                    path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .unwrap();
                db.query_row(
                    "SELECT status,result_json FROM btcc_guided_tool_calls \
                     WHERE turn_id=?1 AND tool_name='update_explicit_memory' \
                     ORDER BY turn_sequence DESC LIMIT 1",
                    [turn],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .unwrap()
            })
            .await
            .unwrap();
            if let Some(row) = row {
                return row;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("explicit memory tool did not enter the durable journal")
}
