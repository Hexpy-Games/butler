//! A local Responses stub for one exact command followed by a streamed reply.
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};
pub(super) const STREAM_CHUNK_DELAY: u64 = 1500;
pub(super) const PROMPT: &str = "Review the command";
pub(super) const ACTION: &str = "printf '%s\\n' --message-format";
pub(super) fn cassette() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    let template = cassette.exchanges[0].clone();
    cassette.exchanges.clear();
    for step in 0..2 {
        let mut exchange = template.clone();
        exchange.request.key.user_request = PROMPT.into();
        exchange.request.key.round = if step == 0 {
            vec![]
        } else {
            vec!["function_call".into(), "function_call_output".into()]
        };
        let item = if step == 0 {
            json!({"type":"function_call","id":"fc_command","call_id":"call_command","name":"run_command","arguments":json!({"command":ACTION,"summary":"Print argument","state_effect":"mutation"}).to_string(),"status":"completed"})
        } else {
            json!({"type":"message","id":"msg_reply","role":"assistant","phase":"final_answer","status":"completed","content":[{"type":"output_text","text":"shell answer","annotations":[]}]})
        };
        exchange.response = response(&item, step == 1);
        cassette.exchanges.push(exchange);
    }
    Ok(cassette)
}
fn response(item: &Value, text: bool) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_shell","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if text {
        events.push(json!({"type":"response.output_text.delta","item_id":"msg_reply","output_index":0,"content_index":0,"delta":"shell answer"}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_shell","object":"response","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut event)| {
                event["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: if text && i > 2 { STREAM_CHUNK_DELAY } else { 0 },
                    text: format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap_or_default()
                    ),
                }
            })
            .collect(),
    }
}
