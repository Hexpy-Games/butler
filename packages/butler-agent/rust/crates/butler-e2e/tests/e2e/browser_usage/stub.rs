use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};

pub(super) fn cassette(failed: bool) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_act"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_open","arguments":{"url":"https://example.com"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"fixture"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_observe","arguments":{"tab":"fixture"}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = "Use browser then finish".into();
        exchange.request.key.round = round.clone();
        exchange.response = response(
            &json!({"type":"function_call","id":format!("fc_browser_{index}"),"call_id":format!("call_browser_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = "Use browser then finish".into();
    last.request.key.round = round;
    last.response = response(
        &json!({"type":"message","id":"msg_browser","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    if failed {
        last.response = ResponseRecord { status: 400, headers: vec![], chunks: vec![Chunk { delay_ms: 0, text: json!({"error":{"type":"invalid_request_error","message":"Injected stub failure"}}).to_string() }] };
    }
    cassette.exchanges.push(last);
    Ok(cassette)
}
pub(super) fn action_cassette() -> Result<Cassette, HarnessError> {
    let mut c = cassette(false)?;
    let mut last = c.exchanges.pop().unwrap();
    let mut action = c.exchanges[2].clone();
    action.response = response(
        &json!({"type":"function_call","id":"fc_act","call_id":"call_act","name":"tool_call","arguments":json!({"id":"native:browser_act","arguments":{"tab":"fixture","observation":"fixture-obs","steps":[{"action":"click","ref":"e1"},{"action":"click","ref":"e1"}]}}).to_string(),"status":"completed"}),
    );
    last.request.key.round = action.request.key.round.clone();
    last.request
        .key
        .round
        .extend(["function_call".into(), "function_call_output".into()]);
    c.exchanges.truncate(2);
    c.exchanges.push(action);
    c.exchanges.push(last);
    Ok(c)
}
fn response(item: &Value) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_browser","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_browser","object":"response","model":"gpt-6-sol","status":"completed","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut e)| {
                e["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: 0,
                    text: format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()),
                }
            })
            .collect(),
    }
}
