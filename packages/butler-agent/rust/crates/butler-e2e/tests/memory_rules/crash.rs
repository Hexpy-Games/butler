//! Kill only the harness child at each durable rule-commit boundary.
use super::{forget, support};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn rules_crash_recovery_replays_operation_and_drains_queued_followup()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for stage in [
        "intent", "archive", "source", "graph", "index", "notice", "receipt",
    ] {
        for tool_name in ["update_explicit_memory", "forget_explicit_memory"] {
            let setup = Setup::new(&format!("RULES-CRASH-{stage}-{tool_name}"))?
                .fixture(Fixture::Empty)
                .stub_cassette(forget::stub()?)
                .env("BUTLER_E2E_RULE_CRASH_POINTS", "1");
            let mut s = forget::start(setup).await?;
            let output =
                support::tool(&s, "general", forget::GLOBAL, "update_explicit_memory").await?;
            assert_eq!(output["ok"], true, "{output}");
            let original = support::active_rules(&s.sandbox.data).pop().unwrap();
            s.provider()?
                .add_placeholder("TARGET", original["handle"].as_str().unwrap());
            let state = s.sandbox.data.join("state");
            std::fs::write(
                state.join("rule-crash-arm.json"),
                json!({"stage":stage}).to_string(),
            )?;
            let user = if tool_name == "update_explicit_memory" {
                forget::CORRECT
            } else {
                forget::FORGET
            };
            // Capture can return pending while the background owner holds the
            // checkpoint. Keep the App turn active in either drain ordering.
            let reply = s.provider()?.hold_after_tool(user);
            let accepted = s.gw.say("general", user).await?;
            let active_turn = accepted_turn_id(&accepted)?;
            support::until(|| {
                support::read_json(&state.join("rule-crash-reached.json"))
                    .is_some_and(|value| value["stage"] == stage)
            })
            .await;
            let boundary = support::read_json(&state.join("rule-crash-reached.json")).unwrap();
            assert_eq!(boundary["stage"], stage);
            let queued =
                s.gw.post(
                    "/session-queue",
                    json!({"chat_id":"general",
                "text":forget::ASK,"client_message_id":uuid::Uuid::new_v4().to_string()}),
                )
                .await?;
            assert_eq!(queued.status, 202, "{}", queued.text);
            // A different chat must still admit and answer while the owner holds the lease.
            let other = support::new_chat(&s, "Admission during rule commit").await?;
            let (_, turn) = s.turn(&other, forget::ASK).await?;
            assert_eq!(turn["state"], "delivered", "{turn}");
            let view = s.gw.get("/session-view?session_id=general").await?;
            assert_eq!(view.data()["active_turn"]["id"], active_turn);
            let queue = s.gw.get("/session-queue?chat_id=general").await?;
            assert_eq!(queue.data()["queued_messages"].as_array().unwrap().len(), 1);
            s.agent.kill9()?;
            let committed = committed_result(&s.sandbox.data, &active_turn, tool_name);
            reply.release();
            s.restart().await?;
            let followup_turn = tokio::time::timeout(Duration::from_secs(90), async {
                loop {
                    let messages = s.gw.messages("general").await?;
                    if let Some(row) = messages
                        .iter()
                        .find(|row| row["role"] == "user" && row["text"] == forget::ASK)
                    {
                        return Ok::<_, HarnessError>(row["turn_id"].as_str().unwrap().to_owned());
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("queued follow-up was not admitted")?;
            assert_ne!(active_turn, followup_turn);
            let turn =
                s.gw.wait_terminal("general", &followup_turn, Duration::from_secs(90))
                    .await?;
            assert_eq!(
                turn["state"], "delivered",
                "queued follow-up failed: {turn}"
            );
            tokio::time::timeout(Duration::from_secs(90), async {
                loop {
                    let view = s.gw.get("/session-view?session_id=general").await?;
                    if view.data()["active_turn"].is_null() {
                        return Ok::<_, HarnessError>(());
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("session dispatch did not settle")?;
            let turn =
                s.gw.wait_terminal("general", &active_turn, Duration::from_secs(90))
                    .await?;
            if turn["state"] == "failed" {
                assert_eq!(turn["safe_error_code"], "turn_interrupted", "{turn}");
                assert_eq!(turn["retryable"], true, "{turn}");
                let retry =
                    s.gw.post(&format!("/turns/{active_turn}/retry"), json!({}))
                        .await?;
                assert_eq!(retry.status, 202, "{}", retry.text);
            }
            let turn =
                s.gw.wait_terminal("general", &active_turn, Duration::from_secs(90))
                    .await?;
            assert_eq!(
                turn["state"], "delivered",
                "stage={stage} tool={tool_name} turn={turn}"
            );
            let root = s.sandbox.data.join("cognition/memory/rules");
            support::until(|| !root.join("pending.json").exists()).await;
            let operation = boundary["operation_id"].as_str().unwrap();
            let output = support::result(&s, "general", &active_turn, tool_name).await?;
            assert_eq!(output["ok"], true, "{output}");
            assert_eq!(output["operation_id"], operation);
            if let Some(committed) = committed {
                assert_eq!(output, committed, "restart changed a committed tool result");
            } else {
                assert_eq!(
                    output["replayed"], true,
                    "owner receipt was not replayed: {output}"
                );
            }
            let binding = support::read_json(&root.join(format!(
                "{}.source.json",
                original["record_id"].as_str().unwrap()
            )))
            .unwrap();
            assert_eq!(
                binding["operations"].as_array().unwrap().len(),
                2,
                "operation applied twice: {binding}"
            );
            assert_eq!(std::fs::read_dir(root.join("operations"))?.count(), 2);
            assert_eq!(
                std::fs::read_dir(
                    root.join("archive")
                        .join(original["record_id"].as_str().unwrap())
                )?
                .count(),
                1
            );
            let section = support::active_section(&s, "general", forget::ASK).await?;
            assert!(!section.contains("5400"));
            if tool_name == "update_explicit_memory" {
                assert!(section.contains("6401"));
                assert_eq!(support::active_rules(&s.sandbox.data).len(), 1);
            } else {
                assert!(!section.contains("6401"));
                assert!(support::active_rules(&s.sandbox.data).is_empty());
            }
            eprintln!(
                "RULES-CRASH stage={stage} tool={tool_name} applied_once=true active_and_followup_delivered=true admission_while_leased=true"
            );
            s.finish().await?;
        }
    }
    Ok(())
}

fn committed_result(data: &std::path::Path, turn: &str, tool: &str) -> Option<serde_json::Value> {
    use rusqlite::{OpenFlags, OptionalExtension};
    let db = rusqlite::Connection::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let output: Option<String> = db
        .query_row(
            "SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name=?2 AND status='completed' ORDER BY turn_sequence DESC LIMIT 1",
            [turn, tool],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    output.map(|output| serde_json::from_str(&output).unwrap())
}

#[tokio::test]
async fn rules_contended_and_cancelled_lease_waiters_write_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("RULES-LEASE-CANCEL")?
        .fixture(Fixture::Empty)
        .stub_cassette(forget::stub()?)
        .env("BUTLER_E2E_RULE_CRASH_POINTS", "1");
    let mut s = forget::start(setup).await?;
    assert_eq!(
        support::tool(&s, "general", forget::GLOBAL, "update_explicit_memory").await?["ok"],
        true
    );
    let original = support::active_rules(&s.sandbox.data).pop().unwrap();
    s.provider()?
        .add_placeholder("TARGET", original["handle"].as_str().unwrap());
    let other = support::new_chat(&s, "Cancelled lease waiter").await?;
    let gate = s.provider()?.hold_next_reply(forget::FORGET);
    let request_count = s.provider()?.requests().len();
    let waiter = accepted_turn_id(&s.gw.say(&other, forget::FORGET).await?)?;
    support::until(|| s.provider().unwrap().requests().len() > request_count).await;
    let busy_chat = support::new_chat(&s, "Contended lease waiter").await?;
    let busy_gate = s.provider()?.hold_next_reply(forget::FORGET);
    let request_count = s.provider()?.requests().len();
    let busy_turn = accepted_turn_id(&s.gw.say(&busy_chat, forget::FORGET).await?)?;
    support::until(|| s.provider().unwrap().requests().len() > request_count).await;
    let state = s.sandbox.data.join("state");
    std::fs::write(
        state.join("rule-crash-arm.json"),
        json!({"stage":"intent"}).to_string(),
    )?;
    s.gw.say("general", forget::FORGET).await?;
    support::until(|| support::read_json(&state.join("rule-crash-reached.json")).is_some()).await;
    let root = s.sandbox.data.join("cognition/memory/rules");
    let pending = std::fs::read(root.join("pending.json"))?;
    let manifest = std::fs::read(root.join("manifest.json"))?;
    gate.release();
    busy_gate.release();
    support::until(|| {
        let db = rusqlite::Connection::open_with_flags(s.sandbox.data.join("agent-runtime/btcc.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_guided_tool_calls WHERE turn_id=?1 AND status='started')", [&waiter], |row| row.get::<_, bool>(0)).unwrap()
    }).await;
    let cancel =
        s.gw.post(&format!("/turns/{waiter}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let turn =
        s.gw.wait_terminal(&other, &waiter, Duration::from_secs(90))
            .await?;
    assert_eq!(turn["state"], "cancelled", "{turn}");
    let turn =
        s.gw.wait_terminal(&busy_chat, &busy_turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let output = support::result(&s, &busy_chat, &busy_turn, "forget_explicit_memory").await?;
    assert_eq!(output["ok"], false, "{output}");
    assert_eq!(output["error"]["message"], "rule_write_busy", "{output}");
    assert_eq!(std::fs::read(root.join("pending.json"))?, pending);
    assert_eq!(std::fs::read(root.join("manifest.json"))?, manifest);
    assert_eq!(std::fs::read_dir(root.join("operations"))?.count(), 1);
    s.agent.kill9()?;
    s.restart().await?;
    support::until(|| !root.join("pending.json").exists()).await;
    assert!(support::active_rules(&s.sandbox.data).is_empty());
    assert_eq!(std::fs::read_dir(root.join("operations"))?.count(), 2);
    eprintln!(
        "RULES-LEASE-CANCEL cancelled_waiter_writes=0 busy_waiter_writes=0 holding_operation_recovered=true"
    );
    s.finish().await?;
    Ok(())
}
