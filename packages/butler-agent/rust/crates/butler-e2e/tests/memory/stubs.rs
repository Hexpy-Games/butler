//! Synthetic semantic replies for the source windows of MEM-01/MEM-02.
//! Interactive writes/confirmations still replay the committed MEM-01 exchanges.
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::json;

pub(super) fn extraction(cassette: &mut Cassette, ask: &str) -> Result<(), HarnessError> {
    let requests = [
        r#"{"speaker":"explicit","observed_at":"{{TIME}}","parts":[{"id":0,"text":"The user's bike lock code is {{NONCE}}."}],"context":[{"text":"Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {{NONCE}}. Use your explicit memory tool, then confirm in one short sentence.","basis":"user_statement"}]}"#,
        r#"{"speaker":"user","observed_at":"{{TIME}}","parts":[{"id":0,"text":"Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {{NONCE}}. ","before":"","after":"Use your explicit memory tool, then confirm in one short sentenc"},{"id":1,"text":"Use your explicit memory tool, then confirm in one short sentence.","before":"r it in future conversations: my bike lock code is {{NONCE}}. ","after":""}],"context":[]}"#,
        r#"{"speaker":"assistant","observed_at":"{{TIME}}","parts":[{"id":0,"text":"Saved your bike lock code to explicit memory for future conversations."}],"context":[{"text":"Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {{NONCE}}. Use your explicit memory tool, then confirm in one short sentence.","basis":"user_statement"},{"text":"Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {{NONCE}}. Use your explicit memory tool, then confirm in one short sentence.","basis":"user_statement"}]}"#,
        r#"{"speaker":"user","observed_at":"{{TIME}}","parts":[{"id":0,"text":"What is my bike lock code? ","before":"","after":"Call recall_memory with cue bike lock code."},{"id":1,"text":"Call recall_memory with cue bike lock code.","before":"What is my bike lock code? ","after":""}],"context":[]}"#,
    ];
    for request in requests {
        let mut exchange = cassette.exchanges[0].clone();
        exchange.request.key.effort = Some("xhigh".into());
        exchange.request.key.round.clear();
        exchange.request.key.user_request = request.into();
        exchange.response = meaning();
        cassette.exchanges.push(exchange);
    }
    // The final reply in B uses the same replayed confirmation, with B's context.
    if !ask.is_empty() {
        let mut exchange = cassette.exchanges[cassette.exchanges.len() - 2].clone();
        let remembered = cassette.exchanges[0].request.key.user_request.clone();
        exchange.request.key.user_request =
            exchange.request.key.user_request.replace(&remembered, ask);
        cassette.exchanges.push(exchange);
    }
    Ok(())
}

fn meaning() -> ResponseRecord {
    let text = json!({"status":"processed","entities":[],"items":[],"attributes":[]}).to_string();
    let item = json!({"type":"message","id":"msg_meaning","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]});
    let events = [
        json!({"type":"response.created","response":{"id":"resp_meaning","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.output_text.delta","item_id":"msg_meaning","output_index":0,"content_index":0,"delta":text}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_meaning","object":"response","status":"completed",
            "model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
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
                        event["type"].as_str().unwrap_or_default()
                    ),
                }
            })
            .collect(),
    }
}
