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
    for deny in [false, true] {
        let (mut s, script, server) = super::turn_continuation::setup(
            super::turn_continuation::Mode::ParallelFiles,
            Access::AskFirst,
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
        for card in cards.iter().rev() {
            let reference = card["request_ref"].as_str().unwrap();
            let action = if deny && card["approval"].to_string().contains("lookup-1") {
                "deny"
            } else {
                "allow"
            };
            let response =
                s.gw.post(
                    &format!("/authority-requests/{reference}/{action}?session_id=general"),
                    json!({"scope":"once"}),
                )
                .await?;
            assert_eq!(response.status, 202, "{}", response.text);
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
        for (i, output) in outputs.iter().enumerate() {
            if deny && i == 1 {
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
            "parallel authority: 3 visible requests, 3 terminal results, 2 model rounds; deny={deny}"
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
        .access(Access::AskFirst)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    *script.file_root.lock().unwrap() = setup.sandbox.data.display().to_string();
    for i in 0..3 {
        let root = setup.sandbox.data.join(format!("lookup-{i}"));
        std::fs::create_dir_all(&root)?;
        std::fs::write(root.join(format!("found-{i}.txt")), "fixture")?;
    }
    let s = setup.start().await?;
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
