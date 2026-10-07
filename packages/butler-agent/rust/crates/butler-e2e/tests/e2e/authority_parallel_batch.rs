//! Concurrent observations retain every approval and resume the same model round.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Access, accepted_turn_id},
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn parallel_file_approvals_are_visible_and_individually_resumable() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for decision in ["allow", "deny", "modify"] {
        let deny = decision == "deny";
        let modify = decision == "modify";
        let (mut s, script, server) = super::turn_continuation::setup(
            super::turn_continuation::Mode::ParallelFiles,
            Access::AskAlways,
        )
        .await?;
        for i in 0..3 {
            let directory = s.sandbox.data.join(format!("lookup-{i}"));
            std::fs::create_dir_all(&directory)?;
            std::fs::write(directory.join(format!("found-{i}.txt")), "fixture")?;
        }
        let id = accepted_turn_id(
            &s.gw
                .say("general", "Calculate the total and report the result.")
                .await?,
        )?;
        let paused =
            s.gw.wait_turn(
                "general",
                &id,
                &["waiting_for_form", "delivered", "failed"],
                Duration::from_secs(20),
            )
            .await?;
        assert_eq!(turn_state(&paused), "waiting_for_form", "{paused}");
        let cards = s.gw.approval_requests("general").await?;
        assert_eq!(cards.len(), 3, "every sibling must appear in the App query");
        assert_eq!(script.requests.lock().unwrap().len(), 1);
        // Restart proves the concurrent results survive without reissuing the batch.
        s.restart().await?;
        // Decide later siblings first: their decisions must survive parking them.
        let mut ordered = cards.clone();
        ordered.sort_by_key(|card| card["approval"].to_string());
        if !modify {
            ordered.reverse();
        }
        for card in &ordered {
            let reference = card["request_ref"].as_str().unwrap();
            let action = if modify && card["approval"].to_string().contains("lookup-0") {
                "modify"
            } else if deny && card["approval"].to_string().contains("lookup-1") {
                "deny"
            } else {
                "allow"
            };
            let response =
                s.gw.post(
                    &format!("/authority-requests/{reference}/{action}?session_id=general"),
                    if action == "modify" {
                        json!({"instruction": MODIFICATION})
                    } else {
                        json!({"scope":"once"})
                    },
                )
                .await?;
            assert_eq!(response.status, 202, "{}", response.text);
            if action == "modify" {
                wait_reparked(&s, &id, true).await?;
                s.restart().await?;
            }
        }
        let done =
            s.gw.wait_terminal("general", &id, Duration::from_secs(20))
                .await?;
        assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
        assert!(s.gw.approval_requests("general").await?.is_empty());
        let requests = script.requests.lock().unwrap().clone();
        assert_eq!(
            requests.len(),
            2,
            "approval resumes the batch without another model round"
        );
        let outputs: Vec<_> = requests[1]["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .map(|item| item["output"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(outputs.len(), 3);
        assert_pairing(&requests[1], modify);
        for (i, output) in outputs.iter().enumerate() {
            if modify && i == 0 {
                assert!(output.contains("authority_request_modified"));
            } else if deny && i == 1 {
                assert!(output.contains("authority_request_denied"));
            } else {
                assert!(output.contains(&format!("found-{i}.txt")), "{output}");
            }
            assert!(
                !output.contains("authority_pending"),
                "pending result reached model"
            );
        }
        let messages = s.gw.messages("general").await?;
        let rows = butler_e2e::e2e::gateway::tool_rows(&messages, &id);
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|row| row["safe_tool_name"] == "list_files")
            .collect();
        assert_eq!(rows.len(), 3, "every tool row must reach its real outcome");
        for row in rows {
            let output = s.gw.operation_output(&id, &row).await?;
            assert!(
                !output.contains("authority_pending"),
                "terminal row still waits: {output}"
            );
            assert!(
                matches!(row["state"].as_str(), Some("delivered" | "cancelled")),
                "{row}"
            );
        }
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let (total, pending): (u64, u64) = db.query_row(
            "SELECT count(*),sum(decision='pending') FROM btcc_authority_requests WHERE source_turn_id=?1",
            [&id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!(
            (total, pending),
            (3, 0),
            "no duplicate or abandoned approvals"
        );
        drop(db);
        eprintln!(
            "parallel authority: 3 visible requests, 3 terminal results, 2 model rounds; decision={decision}"
        );
        s.finish().await?;
        server.abort();
    }
    delegated_batch(false).await?;
    delegated_batch(true).await
}

async fn delegated_batch(fault: bool) -> Result<(), HarnessError> {
    use butler_e2e::e2e::{cassette::Cassette, scenario::Setup};
    use std::{sync::atomic::Ordering, time::Instant};
    let (url, script, server) = super::delegate_followup::stub::start(false).await?;
    script.parallel_files.store(true, Ordering::SeqCst);
    script.terminal_fault.store(fault, Ordering::SeqCst);
    let setup = Setup::new("AUTHORITY-PARALLEL-CHILD")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    *script.file_root.lock().unwrap() = setup.sandbox.data.display().to_string();
    for i in 0..3 {
        let root = setup.sandbox.data.join(format!("lookup-{i}"));
        std::fs::create_dir_all(&root)?;
        std::fs::write(root.join(format!("found-{i}.txt")), "fixture")?;
    }
    let mut s = setup.start().await?;
    s.turn("general", super::delegate_followup::stub::OWNER)
        .await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let cards = loop {
        let cards = s.gw.approval_requests("general").await?;
        if cards.len() == 3 {
            break cards;
        }
        assert!(Instant::now() < deadline, "{cards:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    s.restart().await?;
    for card in cards.iter().rev() {
        let reference = card["request_ref"].as_str().unwrap();
        let response =
            s.gw.post(
                &format!("/authority-requests/{reference}/allow?session_id=general"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(response.status, 202, "{}", response.text);
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let response = s.gw.get("/session-view?session_id=general").await?;
        let child = &response.data()["steward_children"][0];
        if child["result"].is_object() {
            assert_eq!(
                child["result"]["status"],
                if fault { "failed" } else { "success" },
                "{child}"
            );
            if fault {
                assert!(
                    child["result"]["summary"]
                        .as_str()
                        .unwrap()
                        .contains("provider_api_error")
                );
                let db =
                    rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
                let code: String = db.query_row(
                    "SELECT code FROM btcc_steward_results WHERE relation_id=?1",
                    [child["relation"]["relation_id"].as_str().unwrap()],
                    |row| row.get(0),
                )?;
                assert_eq!(code, "steward_execution_failed");
            }
            break;
        }
        assert!(Instant::now() < deadline, "{child}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let requests = script.requests.lock().unwrap().clone();
    let resumed =
        requests
            .iter()
            .find(|request| {
                request["input"].as_array().unwrap().iter().any(|item| {
                    item["call_id"] == "file-2" && item["type"] == "function_call_output"
                })
            })
            .unwrap();
    for i in 0..3 {
        assert!(resumed.to_string().contains(&format!("found-{i}.txt")));
    }
    if fault {
        loop {
            if script.requests.lock().unwrap().iter().any(|request| {
                request.to_string().contains("code: provider_api_error")
                    && request.to_string().contains("Resolve this blocker")
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "failure reason did not reach parent model"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    eprintln!("delegated parallel authority: 3 parent-visible requests, 3 complete child results");
    s.finish().await?;
    server.abort();
    Ok(())
}

const MODIFICATION: &str = "Use the remaining two directories instead.";

fn assert_pairing(request: &serde_json::Value, modified: bool) {
    let input = request["input"].as_array().unwrap();
    let calls: Vec<_> = input
        .iter()
        .enumerate()
        .filter(|(_, item)| item["type"] == "function_call")
        .map(|(index, item)| (index, item["call_id"].clone()))
        .collect();
    let outputs: Vec<_> = input
        .iter()
        .enumerate()
        .filter(|(_, item)| item["type"] == "function_call_output")
        .collect();
    assert_eq!(calls.len(), 3);
    assert_eq!(outputs.len(), 3);
    for ((_, call), (_, output)) in calls.iter().zip(&outputs) {
        assert_eq!(call, &output["call_id"]);
    }
    let first = calls[0].0;
    let last = outputs[2].0;
    assert!(
        input[first..=last].iter().all(|item| matches!(
            item["type"].as_str(),
            Some("function_call" | "function_call_output")
        )),
        "user text split the tool batch: {input:?}"
    );
    if modified {
        let modifications: Vec<_> = input
            .iter()
            .enumerate()
            .filter(|(_, item)| item["role"] == "user" && item.to_string().contains(MODIFICATION))
            .collect();
        assert_eq!(modifications.len(), 1);
        assert!(
            modifications[0].0 > last,
            "modification must follow all results"
        );
    }
}

async fn wait_reparked(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
    modified: bool,
) -> Result<(), HarnessError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let continuation: Option<String> = {
            let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
            db.query_row(
                "SELECT authority_continuation_json FROM btcc_turns WHERE turn_id=?1",
                [id],
                |row| row.get(0),
            )?
        };
        if let Some(raw) = continuation {
            let state: serde_json::Value = serde_json::from_str(&raw)?;
            if state["batch"]["nextCallIndex"] == 1 {
                if modified {
                    assert_eq!(
                        state["batch"]["pendingModifications"],
                        json!([MODIFICATION])
                    );
                }
                return Ok(());
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "modification did not repark"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn cancelling_suspended_parallel_batch_settles_every_request_and_row()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for allow_first in [false, true] {
        let (mut s, script, server) = super::turn_continuation::setup(
            super::turn_continuation::Mode::ParallelFiles,
            Access::AskAlways,
        )
        .await?;
        for i in 0..3 {
            let root = s.sandbox.data.join(format!("lookup-{i}"));
            std::fs::create_dir_all(&root)?;
            std::fs::write(root.join(format!("found-{i}.txt")), "fixture")?;
        }
        let id = accepted_turn_id(
            &s.gw
                .say("general", "Calculate the total and report the result.")
                .await?,
        )?;
        let paused =
            s.gw.wait_turn(
                "general",
                &id,
                &["waiting_for_form", "failed"],
                Duration::from_secs(20),
            )
            .await?;
        assert_eq!(turn_state(&paused), "waiting_for_form");
        assert_eq!(s.gw.approval_requests("general").await?.len(), 3);
        if allow_first {
            let cards = s.gw.approval_requests("general").await?;
            let first = cards
                .iter()
                .find(|card| card["approval"].to_string().contains("lookup-0"))
                .unwrap();
            let reference = first["request_ref"].as_str().unwrap();
            let response =
                s.gw.post(
                    &format!("/authority-requests/{reference}/allow?session_id=general"),
                    json!({"scope":"once"}),
                )
                .await?;
            assert_eq!(response.status, 202);
            wait_reparked(&s, &id, false).await?;
        }
        let response = s.gw.post(&format!("/turns/{id}/cancel"), json!({})).await?;
        assert_eq!(response.status, 202, "{}", response.text);
        let done =
            s.gw.wait_terminal("general", &id, Duration::from_secs(20))
                .await?;
        assert_eq!(turn_state(&done), "cancelled");
        assert!(s.gw.approval_requests("general").await?.is_empty());
        let messages = wait_cancelled_rows(&s, &id, allow_first).await?;
        let rows = butler_e2e::e2e::gateway::tool_rows(&messages, &id);
        assert_eq!(rows.len(), 3);
        for row in rows {
            let settled = allow_first
                && row["safe_input_label"]
                    .as_str()
                    .unwrap()
                    .contains("lookup-0");
            assert!(
                if settled {
                    row["state"] == "delivered"
                } else {
                    row["state"] == "cancelled"
                },
                "{row}"
            );
            assert!(
                !s.gw
                    .operation_output(&id, &row)
                    .await?
                    .contains("authority_pending")
            );
        }
        let pending: u64 = {
            let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
            let closed: u64 = db.query_row(
                "SELECT count(*) FROM btcc_authority_requests WHERE source_turn_id=?1 AND close_reason='session_cancelled' AND closed_at IS NOT NULL",
                [&id], |row| row.get(0),
            )?;
            assert_eq!(closed, if allow_first { 2 } else { 3 });
            db.query_row("SELECT count(*) FROM btcc_authority_requests WHERE source_turn_id=?1 AND decision='pending' AND closed_at IS NULL",
            [&id], |row| row.get(0))?
        };
        assert_eq!(pending, 0);
        assert_eq!(script.requests.lock().unwrap().len(), 1);
        s.restart().await?;
        assert!(s.gw.approval_requests("general").await?.is_empty());
        assert_eq!(
            turn_state(&s.gw.turn("general", &id).await?.unwrap()),
            "cancelled"
        );
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

async fn wait_cancelled_rows(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
    allow_first: bool,
) -> Result<Vec<serde_json::Value>, HarnessError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let messages = s.gw.messages("general").await?;
        let rows = butler_e2e::e2e::gateway::tool_rows(&messages, id);
        let mut settled = rows.len() == 3;
        for row in rows {
            let completed = allow_first
                && row["safe_input_label"]
                    .as_str()
                    .unwrap()
                    .contains("lookup-0");
            settled &= row["state"] == if completed { "delivered" } else { "cancelled" };
            settled &= !s
                .gw
                .operation_output(id, &row)
                .await?
                .contains("authority_pending");
        }
        if settled {
            return Ok(messages);
        }
        assert!(
            std::time::Instant::now() < deadline,
            "cancelled rows did not settle: {messages:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
