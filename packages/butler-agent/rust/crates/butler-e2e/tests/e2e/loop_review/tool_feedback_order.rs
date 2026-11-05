//! A local reply with one valid and one undecodable tool call sends round 2 as
//! assistant(tool_calls) -> tool results -> feedback.
use super::common::run;
use butler_e2e::e2e::{HarnessError, gateway::turn_state};
use serde_json::{Value, json};

async fn check(id: &str, first: Value) -> Result<(), HarnessError> {
    let r = run(
        id,
        vec![
            first,
            json!({"role":"assistant","content":"Round two answer."}),
        ],
        "List the files here.",
    )
    .await?;
    assert!(r.requests.len() >= 2, "round 2 was never sent: {}", r.turn);
    let messages = r.requests[1]["messages"].as_array().unwrap();
    let call_at = messages
        .iter()
        .rposition(|m| m["role"] == "assistant" && m["tool_calls"].is_array())
        .unwrap();
    let after: Vec<&str> = messages[call_at + 1..]
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(after, ["tool", "user"]);
    assert!(
        messages.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("were not run")
    );
    assert_eq!(turn_state(&r.turn), "delivered", "{}", r.turn);
    assert_eq!(
        r.reply.unwrap()["text"].as_str().unwrap().trim(),
        "Round two answer."
    );
    Ok(())
}

#[tokio::test]
async fn structured_valid_plus_nameless_call_reaches_round_two() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    check(
        "FEEDBACK-ORDER-STRUCTURED",
        json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"ok_1","type":"function","function":{"name":"list_files","arguments":"{\"root\":\".\"}"}},
            {"id":"bad_2","type":"function","function":{"arguments":"{}"}}
        ]}),
    )
    .await
}

#[tokio::test]
async fn text_valid_plus_malformed_call_reaches_round_two() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    check(
        "FEEDBACK-ORDER-TEXT",
        json!({"role":"assistant","content":
            "<tool_call>{\"name\":\"list_files\",\"arguments\":{\"root\":\".\"}}</tool_call>\n<tool_call>{\"name\":\"list_files\",\"arguments\":</tool_call>"}),
    )
    .await
}
