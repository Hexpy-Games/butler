//! Model-caused failures continue through feedback; delivery contains model text.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    scenario::Setup,
};
use serde_json::{Value, json};

fn response(text: &str) -> ResponseRecord {
    let item = json!({"type":"message","id":"msg_feedback","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]});
    let events = [
        json!({"type":"response.created","response":{"id":"resp_feedback","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.output_text.delta","item_id":"msg_feedback","output_index":0,"content_index":0,"delta":text}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_feedback","object":"response","status":"completed",
            "model":"gpt-6-sol","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
    ];
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut event)| {
                event["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: 0,
                    text: format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    ),
                }
            })
            .collect(),
    }
}

#[tokio::test]
async fn repeated_empty_responses_reach_model_and_do_not_end_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TURN-02")?;
    let template = cassette.exchanges[0].clone();
    cassette.exchanges.clear();
    for round in 0..4 {
        let mut exchange = template.clone();
        exchange.request.key.round = vec!["user".into(); round];
        exchange.response = response(if round == 3 { "once" } else { "" });
        cassette.exchanges.push(exchange);
    }
    let s = Setup::new("AGENT-EMPTY-FEEDBACK")?
        .stub_cassette(cassette)
        .start()
        .await?;
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 4);
    let last = requests.last().unwrap().to_string();
    assert_eq!(last.matches("Your previous response was empty").count(), 3);
    assert!(last.contains("occurred 3 times"));
    let messages = s.gw.messages("general").await?;
    let assistant: Vec<&Value> = messages
        .iter()
        .filter(|m| m["role"] == "assistant")
        .collect();
    assert_eq!(assistant.len(), 1);
    assert_eq!(assistant[0]["text"], "once");
    s.finish().await
}

#[tokio::test]
async fn raw_tool_payload_stays_out_of_delivered_messages() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AGENT-RAW-RESULT")?
        .cassette("TOOL-01")
        .replay_only()
        .start()
        .await?;
    let cassette = Cassette::load("TOOL-01")?;
    let request = &cassette.exchanges[0].request.key.user_request;
    let (_, turn) = s.turn("general", request).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert!(requests.len() >= 2);
    assert!(requests[1].to_string().contains("function_call_output"));
    let messages = s.gw.messages("general").await?;
    assert_eq!(
        messages.iter().filter(|m| m["role"] == "assistant").count(),
        1
    );
    for message in messages.iter().filter(|m| m["role"] == "assistant") {
        let text = message["text"].as_str().unwrap();
        assert!(
            !text.contains("tool_call_id")
                && !text.contains("function_call_output")
                && !text.contains("operationResultReference")
        );
        assert_eq!(
            text,
            cassette
                .exchanges
                .last()
                .unwrap()
                .response
                .output_text()
                .trim()
        );
    }
    s.finish().await
}

#[tokio::test]
async fn hosted_prose_tool_call_is_preserved_and_corrected() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TURN-02")?;
    let mut first = cassette.exchanges[0].clone();
    first.response =
        response("<tool_call>call: read_file {requests:[{path:\"inside.txt\"}]}</tool_call>");
    let mut final_exchange = cassette.exchanges[0].clone();
    final_exchange.request.key.round = vec!["message".into(), "user".into()];
    final_exchange.response = response("once");
    cassette.exchanges = vec![first, final_exchange];
    let s = Setup::new("AGENT-HOSTED-TEXT-CALL")?
        .stub_cassette(cassette)
        .start()
        .await?;
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 2);
    let repaired = requests[1].to_string();
    assert!(
        repaired.contains("<tool_call>"),
        "retain the rejected assistant text as evidence"
    );
    assert!(repaired.contains("They were not executed"));
    assert!(repaired.contains("schema-valid arguments"));
    let messages = s.gw.messages("general").await?;
    let assistant: Vec<_> = messages
        .iter()
        .filter(|m| m["role"] == "assistant")
        .collect();
    assert_eq!(assistant.len(), 1);
    assert_eq!(assistant[0]["text"], "once");
    assert!(
        butler_e2e::e2e::gateway::tool_rows(&messages, turn["id"].as_str().unwrap()).is_empty(),
        "prose calls must not execute"
    );
    s.finish().await
}
