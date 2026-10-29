//! A lost inline lease race must leave a wakeup after the consumer parks.
use super::{forget, support};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Scenario, Setup, accepted_turn_id},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Duration;

const SAVE: &str =
    "Remember this durable explicit rule: answer with metric units. Use update_explicit_memory.";
const TEXT: &str = "Answer with metric units.";
const PARKED: &str = "[memory-sync-trace] park delay=None";

#[tokio::test]
async fn rules_inline_busy_drain_wakes_parked_consumer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = forget::stub()?;
    support::add_call(
        &mut cassette,
        SAVE,
        "update_explicit_memory",
        &json!({"kind":"instruction","text":TEXT,"source":SAVE}),
    );
    support::historical(&mut cassette);
    let setup = Setup::new("RULES-DRAIN-WAKEUP")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .env("BUTLER_MEMORY_SYNC_TRACE", "1")
        .env("BUTLER_E2E_RULE_CAPTURE_DRAIN_BARRIER", "1");
    let s = forget::start(setup).await?;
    let first = support::tool(&s, "general", forget::GLOBAL, "update_explicit_memory").await?;
    assert_eq!(first["ok"], true, "{first}");
    support::until(|| support::active_rules(&s.sandbox.data).len() == 1).await;
    let original = support::active_rules(&s.sandbox.data).pop().unwrap();
    support::projection(&s.sandbox.data, &original).await;
    crate::memory_fixture::wait_parked(&s).await;

    let state = s.sandbox.data.join("state");
    std::fs::write(state.join("rule-capture-drain-arm"), b"")?;
    // Keep conversation completion from supplying an unrelated memory wakeup.
    let reply = s.provider()?.hold_after_tool(SAVE);
    let turn = accepted_turn_id(&s.gw.say("general", SAVE).await?)?;
    support::until(|| state.join("rule-capture-drain-reached").exists()).await;
    let parked_before = parked_count(&s).await;
    wait_for_new_park(&s, parked_before).await;
    std::fs::write(state.join("rule-capture-drain-release"), b"")?;
    // Reply delivery is held: read the completed tool-owner receipt directly.
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    support::until(|| {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='update_explicit_memory' AND status='completed')",
            [&turn], |row| row.get::<_, bool>(0),
        ).unwrap()
    })
    .await;
    let result: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='update_explicit_memory' AND status='completed' ORDER BY turn_sequence DESC LIMIT 1",
        [&turn], |row| row.get(0),
    )?;
    let output: serde_json::Value = serde_json::from_str(&result)?;
    drop(db);
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["state"], "pending", "{output}");
    let operation = output["operation_id"].as_str().unwrap();
    let receipt = s
        .sandbox
        .data
        .join("cognition/memory/rules/capture-receipts")
        .join(format!("{:x}.json", Sha256::digest(operation.as_bytes())));
    support::until(|| {
        support::read_json(&receipt).is_some_and(|row| {
            row["submitted"]["operation_id"] == operation && row["submitted"]["text"] == TEXT
        }) && {
            let rules = support::active_rules(&s.sandbox.data);
            rules.len() == 2
                && rules.iter().any(|row| row == &original)
                && rules.iter().any(|row| row["handle"] == output["rule"])
        }
    })
    .await;
    reply.release();
    let delivered =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(delivered["state"], "delivered", "{delivered}");
    s.finish().await
}

async fn parked_count(s: &Scenario) -> usize {
    s.agent
        .current_logs()
        .await
        .unwrap()
        .lines()
        .filter(|line| line.ends_with(PARKED))
        .count()
}

async fn wait_for_new_park(s: &Scenario, before: usize) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while parked_count(s).await <= before {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("consumer did not consume the notice and park while WORK was empty");
}
