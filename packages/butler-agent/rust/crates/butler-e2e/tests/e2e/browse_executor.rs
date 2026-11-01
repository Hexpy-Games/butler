//! Stateless delegated browsing, evidence verification, deferred tools and approvals.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod host;
mod recovery;
pub(crate) mod shop;
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Access, Setup},
    security::AdminClient,
};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn browse_batches_stateless_tasks_and_hands_exact_steps_to_browser_act()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSE-EXECUTOR")?
        .stub_cassette(stub::cassette(false)?)
        .access(Access::AskExceptReads)
        .start()
        .await?;
    let reply =
        s.gw.patch("/settings", json!({"browser":{"browsing_agent":"auto"}}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let (host, actions) = host::start(&s).await?;
    let id = s.gw.say_turn("general", stub::TASK).await?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(30),
        )
        .await?;
    assert_eq!(
        turn["state"],
        "waiting_for_form",
        "{turn}\n{}",
        s.agent.logs()
    );
    let cards = s.gw.approval_requests("general").await?;
    assert_eq!(cards.len(), 1, "{cards:?}");
    let operation = &cards[0]["approval"]["operation"];
    assert_eq!(operation["tool"], "browser_act");
    assert_eq!(operation["browser_steps"][0]["action"], "click");
    assert_eq!(operation["browser_steps"][0]["name"], "Order");
    assert_eq!(
        actions.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "commit never dispatched"
    );
    let requests = s.provider()?.requests();
    assert_surface(&requests[0]);
    let results = outputs(requests.last().unwrap());
    let browse: Vec<_> = results
        .iter()
        .filter(|(value, _)| value["output"].get("executor_model").is_some())
        .collect();
    assert_eq!(browse.len(), 2, "{results:?}");
    let done = browse
        .iter()
        .map(|(value, _)| &value["output"])
        .find(|value| value["status"] == "done")
        .unwrap();
    assert_eq!(done["fields"]["price"], "12");
    assert_eq!(done["evidence"][0]["quote"], "Price 12");
    assert_eq!(done["evidence"].as_array().unwrap().len(), 1);
    assert!(
        done["unverified"]
            .as_array()
            .unwrap()
            .contains(&json!("invented"))
    );
    let pending = browse
        .iter()
        .map(|(value, _)| &value["output"])
        .find(|value| value["status"] == "needs_approval")
        .unwrap();
    assert_eq!(pending["handoff"]["steps"], stub::commit());
    assert_eq!(done["tab"], "product-b");
    assert_eq!(
        done["opened_tabs"],
        json!(["listing", "product-a", "product-b"])
    );
    assert_requests(&requests);
    assert_usage(&s.sandbox.data, &id)?;
    let usage = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(
        usage.data()["usage"]["by_role"]["browse"]["request_count"],
        7
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let sources: i64 = db.query_row("SELECT COUNT(DISTINCT read_source) FROM btcc_guided_tool_calls WHERE tool_name='browser_open' AND read_source IS NOT NULL", [], |row| row.get(0))?;
    assert_eq!(sources, 4, "every opened page retains normal provenance");
    drop(db);
    host.abort();
    let _ = host.await;
    s.finish().await
}

#[tokio::test]
async fn browse_provider_failure_returns_unavailable_without_switching_models()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSE-UNAVAILABLE")?
        .stub_cassette(stub::cassette(true)?)
        .start()
        .await?;
    let reply =
        s.gw.patch("/settings", json!({"browser":{"browsing_agent":"auto"}}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let (host, actions) = host::start(&s).await?;
    let (_, turn) = s.turn("general", stub::TASK).await?;
    assert_eq!(turn["state"], "delivered");
    let requests = s.provider()?.requests();
    let results = outputs(requests.last().unwrap());
    let result = &results
        .iter()
        .find(|(v, _)| v["output"]["status"] == "executor_unavailable")
        .unwrap()
        .0["output"];
    assert_eq!(
        actions.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "planner browser tools continue"
    );
    assert!(requests.iter().all(|r| r["model"] == requests[0]["model"]));
    assert_eq!(result["status"], "executor_unavailable", "{result}");
    assert!(result["error_code"].is_string());
    let executor: Vec<_> = requests
        .iter()
        .filter(|request| executor(request))
        .collect();
    assert_eq!(executor.len(), 1);
    assert_eq!(executor[0]["model"], requests[0]["model"]);
    host.abort();
    let _ = host.await;
    s.finish().await
}

fn executor(request: &Value) -> bool {
    request["instructions"]
        .as_str()
        .is_some_and(|text| text.starts_with("You operate one browser tab for a planner."))
}

fn assert_surface(request: &Value) {
    let names: Vec<_> = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|tool| {
            tool["tools"]
                .as_array()
                .map_or_else(|| std::slice::from_ref(tool), Vec::as_slice)
        })
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    for name in ["browse", "browser_act", "web_search"] {
        assert!(names.contains(&name), "{names:?}");
    }
    for name in [
        "web_read",
        "browser_open",
        "browser_observe",
        "browser_close",
        "image_collect",
    ] {
        assert!(!names.contains(&name), "{names:?}");
    }
}

fn assert_requests(requests: &[Value]) {
    let executor: Vec<_> = requests
        .iter()
        .filter(|request| executor(request))
        .collect();
    assert_eq!(executor.len(), 7);
    for request in executor {
        assert!(request["tools"].as_array().is_none_or(Vec::is_empty));
        let input = &request["input"];
        assert_eq!(input.as_array().unwrap().len(), 1, "stateless request");
        let text = input[0]["content"][0]["text"].as_str().unwrap();
        let scope: Value =
            serde_json::from_str(text.split_once("Current scope:\n").unwrap().1).unwrap();
        let keys: std::collections::BTreeSet<_> = scope
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["fields", "step", "action_log", "notes", "view"]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
        );
        assert!(scope["view"].get("delta_of").is_none());
        let view = scope["view"].to_string();
        for marker in ["Earlier listing", "First product:", "Latest product"] {
            if !view.contains(marker) {
                assert!(!text.contains(marker), "earlier view leaked: {text}");
            }
        }
        assert!(!text.contains("delta_of"));
        assert!(scope["notes"].as_str().unwrap().chars().count() <= 2_000);
        if scope["view"]["ranked"] == true {
            let count = scope["view"]["chunks"].as_array().unwrap().len()
                + scope["view"]["more_chunks"].as_array().unwrap().len();
            assert_eq!(
                count as u64,
                scope["view"]["total_chunks"].as_u64().unwrap()
            );
        }
    }
}

fn assert_usage(data: &std::path::Path, turn: &str) -> Result<(), HarnessError> {
    let text = std::fs::read_to_string(data.join("metrics/prompt-cache-usage.jsonl"))?;
    let all: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let root = all
        .iter()
        .find(|row| row["turnId"] == turn && row["role"] == "main")
        .unwrap()["rootSessionId"]
        .clone();
    assert!(root.is_string());
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|row: &Value| row["scope"] == "browse-executor")
        .collect();
    assert_eq!(rows.len(), 7, "{rows:?}");
    for row in rows {
        assert_eq!(row["rootSessionId"], root);
        assert_eq!(row["role"], "browse");
        assert_eq!(row["turnId"], turn);
    }
    Ok(())
}

fn outputs(request: &Value) -> Vec<(Value, bool)> {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| {
            let output = &item["output"];
            let text = output.as_str().or_else(|| {
                output
                    .as_array()?
                    .iter()
                    .find_map(|part| part["text"].as_str())
            })?;
            Some((serde_json::from_str(text).ok()?, false))
        })
        .collect()
}

#[tokio::test]
async fn executor_hands_off_payment_even_with_a_standing_merchant_permission()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSE-PAYMENT-HANDOFF")?
        .stub_cassette(stub::payment_cassette()?)
        .start()
        .await?;
    let reply =
        s.gw.patch("/settings", json!({"browser":{"browsing_agent":"auto"}}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let (host, actions) = host::start(&s).await?;
    let (_, turn) = s.turn("general", "Inspect checkout").await?;
    assert_eq!(turn["state"], "delivered");
    let requests = s.provider()?.requests();
    let outputs = outputs(requests.last().unwrap());
    let result = &outputs.last().unwrap().0["output"];
    assert_eq!(result["status"], "needs_approval");
    assert_eq!(
        result["handoff"]["steps"],
        json!([{"action":"click","ref":"f0-e90"}])
    );
    assert_eq!(actions.load(std::sync::atomic::Ordering::SeqCst), 0);
    host.abort();
    let _ = host.await;
    s.finish().await
}
