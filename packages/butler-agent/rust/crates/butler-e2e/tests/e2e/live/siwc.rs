//! LIVE-SIWC (spec-siwc-p14 §14.6): the official ChatGPT plan route, once.
//!
//! Records one namespaced function-tool round trip through the normal
//! sanitizer and checks `/v1/models`. The record budget allows exactly the
//! tool round, its follow-up and one model-list read; background work is
//! refused, never forwarded. Reports request shapes and response header
//! NAMES only, never values.
use std::collections::BTreeSet;

use butler_e2e::e2e::config::{ModelChoice, flag};
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::{HarnessError, harness_error, nonce};
use serde_json::{Value, json};

const ID: &str = "LIVE-SIWC";
const PROMPT: &str = "Read the file notes.txt in your workspace and tell me the secret word.";

pub(super) async fn check() -> Result<(), HarnessError> {
    let choice = ModelChoice::parse("openai/gpt-6-luna@low")
        .ok_or_else(|| harness_error("invalid LIVE-SIWC model"))?;
    let secret = nonce();
    let mut setup = Setup::new(ID)?
        .cassette(ID)
        .model(choice)
        .placeholder("NONCE", &secret)
        .record_budget(PROMPT, 2, 1);
    if !flag("BUTLER_E2E_RECORD") {
        let scratch = std::env::temp_dir().join(format!("butler-e2e-siwc-{}", nonce()));
        setup = setup.record_into(scratch);
    }
    std::fs::write(
        setup.sandbox.data.join("notes.txt"),
        format!("the secret word is {secret}\n"),
    )?;
    let s = setup.start().await?;
    let catalog = s.gw.get("/model-catalog").await?;
    super::live::spend_turn()?;
    let (turn_id, turn) = s.turn("general", PROMPT).await?;
    let recorder = s.provider()?;
    let listed = recorder.upstream_models();
    let report = json!({
        "models": listed,
        "chatgpt_plan_models": plan_models(catalog.data()),
        "requests": recorder.requests().iter().map(shape).collect::<Vec<_>>(),
        "response_header_names": recorder.upstream_header_names(),
        "refused": recorder.refused(),
        "turn_state": super::turn_state(&turn),
    });
    super::live::report(ID, &format!("REPORT {report}"));
    let answer = super::answer(&s, "general", &turn_id).await?;
    let rows = super::tool_rows(&s.gw.messages("general").await?, &turn_id);
    assert!(
        listed
            .as_ref()
            .and_then(Value::as_array)
            .is_some_and(|models| {
                models
                    .iter()
                    .any(|m| m["slug"] == "gpt-6-luna" && m["visibility"] == "list")
            }),
        "gpt-6-luna is not listed"
    );
    assert_eq!(super::turn_state(&turn), "delivered", "{turn}");
    assert!(
        rows.iter().any(|row| row["safe_tool_name"] == "read_file"),
        "{rows:?}"
    );
    assert!(answer.contains(&secret), "answer lacks the file nonce");
    s.finish().await
}

fn plan_models(catalog: &Value) -> Value {
    catalog["providers"]
        .as_array()
        .and_then(|providers| providers.iter().find(|p| p["provider_id"] == "openai"))
        .map_or(Value::Null, |provider| {
            provider["chatgpt_plan_models"].clone()
        })
}

/// Request structure without content: key names, tool wrapper shape and the
/// history item shapes the follow-up re-sends.
fn shape(body: &Value) -> Value {
    let keys = |value: &Value| -> Vec<String> {
        value
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default()
    };
    let tools: Vec<Value> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| {
            let children = tool["tools"].as_array().cloned().unwrap_or_default();
            let child_keys: BTreeSet<String> = children.iter().flat_map(&keys).collect();
            let child_types: BTreeSet<String> = children
                .iter()
                .filter_map(|c| c["type"].as_str().map(str::to_owned))
                .collect();
            json!({"type": tool["type"], "name": tool["name"], "keys": keys(tool),
                "children": children.len(), "child_types": child_types, "child_keys": child_keys})
        })
        .collect();
    let input: Vec<Value> = body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let mut entry = json!({"type": item["type"], "role": item["role"], "keys": keys(item)});
            if item["type"] == "function_call" {
                entry["namespace"] = item["namespace"].clone();
                entry["name"] = item["name"].clone();
            }
            entry
        })
        .collect();
    json!({"keys": keys(body), "store": body["store"], "stream": body["stream"],
        "tool_choice": body["tool_choice"], "include": body["include"],
        "reasoning": body["reasoning"], "text": body["text"], "tools": tools, "input": input})
}
