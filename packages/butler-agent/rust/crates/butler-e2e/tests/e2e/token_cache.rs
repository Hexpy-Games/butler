//! Cache contracts through the public provider, gateway, journal and filesystem.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::turn_continuation::{Mode, setup};
use butler_e2e::e2e::{HarnessError, gateway::tool_rows, scenario::Access};
use serde_json::{Value, json};

fn prompt_budget_ratchet() -> Result<(), HarnessError> {
    let baseline: std::collections::BTreeMap<String, usize> =
        serde_json::from_str(include_str!("token_cache/prefix-budgets.json"))?;
    let root = butler_e2e::e2e::binary::workspace_root();
    let prefixes: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&std::fs::read_to_string(root.join(
            "crates/butler-turn/src/btcc/guided_turn/phase/instruction-prefixes.json",
        ))?)?;
    assert_eq!(baseline.len(), prefixes.len());
    let tokenizer = tiktoken_rs::o200k_base().map_err(|error| HarnessError(error.to_string()))?;
    for (profile, prefix) in prefixes {
        let tokens = tokenizer.encode_ordinary(&prefix).len();
        assert!(
            tokens <= baseline[&profile],
            "{profile}: {tokens} tokens exceeds {}",
            baseline[&profile]
        );
    }
    Ok(())
}
#[tokio::test]
async fn nested_diff_spellings_are_removed_only_from_model_projection() -> Result<(), HarnessError>
{
    use butler_e2e::e2e::{nonce, scenario::Setup};
    butler_e2e::gate!();
    let marker = nonce();
    let result = json!({"content":[{"type":"text","text":format!("e2e token {marker}")}],
        "structuredContent":{"receipt":"evidence-preserved","nested":[
            {"changed_file":{"after_text":"UI detail"},"keep":"first"},
            {"changed_files":[{"before_text":"UI detail"}],"keep":"second"},
            {"changedFiles":{"lines":["UI detail"]},"keep":"third"}]}});
    let s = Setup::new("CACHE-NESTED-DIFF")?
        .cassette("MCP-01")
        .placeholder("NONCE", &marker)
        .start()
        .await?;
    super::mcp::add_server(
        &s,
        vec![json!({"key":"E2E_MCP_RESULT_JSON","source":"literal","value":result.to_string()})],
    )
    .await?;
    assert!(super::mcp::healthy(&super::mcp::probe(&s).await?));
    let (id, turn) = s.turn("general", super::mcp::PROMPT).await?;
    assert_eq!(turn["state"], "delivered");
    let requests = s.provider()?.requests();
    let mut kept = false;
    for request in requests {
        for item in request["input"].as_array().unwrap() {
            if let Some(output) = item["output"].as_str() {
                assert_no_changed_files(&serde_json::from_str::<Value>(output)?);
                if output.contains("evidence-preserved") {
                    for value in ["first", "second", "third", &marker] {
                        assert!(output.contains(value));
                    }
                    kept = true;
                }
            }
        }
    }
    assert!(kept);
    let rows = tool_rows(&s.gw.messages("general").await?, &id);
    let mut original = String::new();
    for row in rows {
        original.push_str(&s.gw.operation_output(&id, &row).await?);
    }
    for spelling in ["changed_file", "changed_files", "changedFiles"] {
        assert!(original.contains(spelling));
    }
    s.finish().await
}

#[tokio::test]
async fn final_report_preserves_schemas_and_blocks_repeated_native_calls()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    prompt_budget_ratchet()?;
    for (mode, blocked) in [(Mode::FinalTools, 2), (Mode::FinalEmptyTools, 1)] {
        final_guard(mode, blocked).await?;
    }
    Ok(())
}

async fn final_guard(mode: Mode, blocked_count: usize) -> Result<(), HarnessError> {
    let (s, script, server) = setup(mode, Access::FullAccess).await?;
    let (id, turn) = s
        .turn("general", "Calculate the total and report the result.")
        .await?;
    assert_eq!(turn["state"], "delivered");
    let requests = script.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 11);
    for request in &requests {
        assert_eq!(request["tools"], requests[0]["tools"]);
    }
    let metrics = super::token_metrics::report(&s, &requests, "Final execution policy")?;
    assert!(
        metrics
            .iter()
            .skip(1)
            .all(|row| row["prefixDiagnostics"]["appendOnly"] == true)
    );
    assert!(
        metrics
            .iter()
            .all(|row| row["prefixDiagnostics"]["providerReportedCachedTokens"].is_null())
    );
    assert!(!s.sandbox.data.join("final-mutation.txt").exists());
    assert_eq!(
        s.gw.approval_requests("general").await?,
        [] as [serde_json::Value; 0]
    );
    let messages = s.gw.messages("general").await?;
    let rows = tool_rows(&messages, &id);
    let blocked: Vec<_> = rows
        .iter()
        .filter(|row| row["safe_tool_name"] == "write_file")
        .collect();
    assert_eq!(blocked.len(), blocked_count);
    assert!(blocked.iter().all(|row| row["state"] != "delivered"));
    assert!(
        messages
            .iter()
            .any(|message| message["text"] == "The total is 42.")
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn independent_bookkeeping_shares_one_round_without_optional_records()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(Mode::Batched, Access::FullAccess).await?;
    let (id, turn) = s
        .turn("general", "Calculate the total and report the result.")
        .await?;
    assert_eq!(turn["state"], "delivered");
    let requests = script.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 6);
    assert!(
        requests[0]["instructions"]
            .as_str()
            .unwrap()
            .contains("Batch independent bookkeeping calls in one native tool round")
    );
    let metrics = super::token_metrics::report(&s, &requests, "Batched Work replay")?;
    assert_eq!(
        metrics[2]["prefixDiagnostics"]["providerReportedCachedTokens"],
        0
    );
    assert_eq!(
        metrics[2]["prefixDiagnostics"]["providerCachedTokensFieldPresent"],
        true
    );
    assert_eq!(
        metrics[0]["prefixDiagnostics"]["providerCachedTokensFieldPresent"],
        false
    );
    assert!(
        metrics
            .iter()
            .skip(1)
            .all(|row| row["prefixDiagnostics"]["appendOnly"] == true)
    );
    let messages = s.gw.messages("general").await?;
    let rows = tool_rows(&messages, &id);
    let command = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "run_command")
        .unwrap();
    let evidence: Value = serde_json::from_str(&s.gw.operation_output(&id, command).await?)?;
    assert_eq!(evidence["exit_code"], 0);
    assert_eq!(evidence["stdout"].as_str().unwrap().trim(), "42");
    for name in [
        "record_work_review",
        "update_todo_list",
        "run_command",
        "record_work_disposition",
    ] {
        assert!(
            rows.iter()
                .any(|row| row["safe_tool_name"] == name && row["state"] == "delivered")
        );
    }
    assert!(
        !rows
            .iter()
            .any(|row| row["safe_tool_name"] == "record_work_checkpoint")
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["safe_tool_name"] == "record_work_review")
            .count(),
        1
    );
    assert!(
        requests[3]["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .count()
            >= 4
    );
    assert!(
        messages
            .iter()
            .any(|message| message["text"] == "The total is 42.")
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

pub(super) fn assert_no_changed_files(value: &Value) {
    match value {
        Value::Object(fields) => {
            for (name, child) in fields {
                assert!(!matches!(
                    name.as_str(),
                    "changed_file" | "changed_files" | "changedFiles"
                ));
                assert_no_changed_files(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_no_changed_files(item);
            }
        }
        _ => {}
    }
}

pub(super) fn batched_reply(
    step: usize,
    body: &Value,
    progress: fn(usize, &Value) -> Value,
    command: fn(bool) -> Value,
    call: fn(&str, &str, &Value) -> Value,
) -> Value {
    match step {
        0 | 1 => progress(step, body),
        2 => json!([
            progress(2, body),
            call(
                "todo",
                "update_todo_list",
                &json!({"todos":[{"content":"Calculate total","active_form":"Calculating total","status":"in_progress"}]})
            )
        ]),
        3 => command(false),
        4 => progress(7, body),
        _ => progress(8, body),
    }
}

pub(super) fn wire(item: &Value) -> String {
    use std::fmt::Write;
    let items = item
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![item.clone()]);
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_1","status":"in_progress","output":[]}}),
    ];
    for (index, item) in items.iter().enumerate() {
        events.push(json!({"type":"response.output_item.added","output_index":index,"item":item}));
        if item["type"] == "function_call" {
            events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":index,"delta":item["arguments"]}));
            events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":index,"arguments":item["arguments"]}));
        } else if item["type"] == "message" {
            events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":index,"content_index":0,"delta":item["content"][0]["text"]}));
        }
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    let mut usage = json!({"input_tokens":100,"output_tokens":20,"total_tokens":120});
    if item.is_array() {
        usage["input_tokens_details"] = json!({"cached_tokens":0});
    }
    events.push(json!({"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-6-sol","output":items,"usage":usage}}));
    let mut wire = String::new();
    for (index, mut event) in events.into_iter().enumerate() {
        event["sequence_number"] = json!(index);
        write!(
            wire,
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap()
        )
        .unwrap();
    }
    wire
}

pub(super) async fn verify_write_edit(
    s: &butler_e2e::e2e::scenario::Scenario,
    requests: &[Value],
    rows: &[Value],
    turn_id: &str,
    marker: &str,
) -> Result<(), HarnessError> {
    for request in requests {
        assert_eq!(request["tools"], requests[0]["tools"]);
        for item in request["input"].as_array().unwrap() {
            if item["type"] == "function_call_output" {
                let output: Value = serde_json::from_str(item["output"].as_str().unwrap())?;
                assert_no_changed_files(&output);
            }
        }
    }
    for name in ["write_file", "edit_file"] {
        let row = rows
            .iter()
            .find(|row| row["safe_tool_name"] == name)
            .unwrap();
        let evidence = s.gw.operation_output(turn_id, row).await?;
        assert!(
            evidence.contains("changed_file"),
            "App evidence lost its diff"
        );
        assert!(
            evidence.contains(marker),
            "App evidence lost exact file text"
        );
    }
    Ok(())
}
