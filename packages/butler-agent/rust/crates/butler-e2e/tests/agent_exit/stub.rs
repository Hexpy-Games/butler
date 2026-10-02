use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};

pub(super) const PROMPT: &str = "Delegate this task before continuing.";

pub(super) fn cassette(tool: &str, args: &Value) -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    for exchange in &mut cassette.exchanges {
        exchange.request.key.user_request = PROMPT.into();
    }
    cassette.exchanges[0].response = response(&json!({"type":"function_call","id":"fc_policy",
        "call_id":"call_policy","name":tool,"arguments":args.to_string(),"status":"completed"}));
    cassette.exchanges[1].response = response(
        &json!({"type":"message","id":"msg_answer","role":"assistant",
        "status":"completed","content":[{"type":"output_text","text":"done","annotations":[]}]}),
    );
    let followup = Cassette::load("Q-02")?.exchanges.remove(1);
    cassette.exchanges.push(followup.clone());
    let mut historical = followup;
    historical.request.key.round.insert(0, "user".into());
    cassette.exchanges.push(historical);
    Ok(cassette)
}

fn response(item: &Value) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_policy","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":"done"}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_policy","object":"response","status":"completed",
        "model":"gpt-6-sol","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
