use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};
pub(super) const PROMPT: &str = "온보딩 해줘";
pub(super) fn questions(id: &str) -> Value {
    json!({"questions":[{"id":id,"eyebrow":"온보딩","title":"어떻게 불러드리면 좋겠습니까?","kind":"single","allow_custom":true,"options":[{"id":"name","label":"이름으로 부르기"},{"id":"skip","label":"건너뛰기"}]}]})
}
pub(super) fn cassette() -> Result<Cassette, HarnessError> {
    let mut c = Cassette::load("TOOL-01")?;
    let template = c.exchanges[0].clone();
    c.exchanges.clear();
    let items = [
        call("q1", "ask_user", &questions("principal_name")),
        call(
            "save1",
            "update_onboarding_profile",
            &json!({"principal_name":"민수"}),
        ),
        call("q2", "ask_user", &questions("preferred_address")),
        call(
            "save2",
            "update_onboarding_profile",
            &json!({"preferred_address":"민수님", "complete":true}),
        ),
        json!({"type":"message","id":"msg_answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"I received your answer.","annotations":[]}]}),
    ];
    for (index, item) in items.iter().enumerate() {
        let mut exchange = template.clone();
        exchange.request.key.user_request = PROMPT.into();
        exchange.request.key.round = (0..index)
            .flat_map(|_| ["function_call".into(), "function_call_output".into()])
            .collect();
        exchange.response = response(item);
        c.exchanges.push(exchange);
    }
    Ok(c)
}
fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":format!("call_{id}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}
pub(super) fn response(item: &Value) -> ResponseRecord {
    let completed = json!({"id":"resp_question","object":"response","status":"completed","model":"gpt-6-sol",
        "output":[item.clone()],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}});
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_question","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":"I received your answer."}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":completed}));
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
