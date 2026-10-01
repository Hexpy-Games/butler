use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};

pub(super) const PROMPT: &str = "Ask me which output format to use before continuing.";
pub(super) fn questions() -> Value {
    json!({"questions":[{"id":"format","eyebrow":"Output","title":"Which format?","kind":"single","allow_custom":true,
        "options":[{"id":"brief","label":"Brief","recommended":true},{"id":"full","label":"Full","description":"All details"}]}]})
}
pub(super) fn cassette() -> Result<Cassette, HarnessError> {
    let mut c = Cassette::load("TOOL-01")?;
    for e in &mut c.exchanges {
        e.request.key.user_request = PROMPT.into();
    }
    c.exchanges[0].response = response(
        &json!({"type":"function_call","id":"fc_question","call_id":"call_question","name":"ask_user","arguments":questions().to_string(),"status":"completed"}),
    );
    c.exchanges[1].response = response(
        &json!({"type":"message","id":"msg_answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"I received your answer.","annotations":[]}]}),
    );
    // A subsequent queued turn has an additional historical-context user item.
    for exchange in c.exchanges.clone() {
        let mut historical = exchange;
        historical.request.key.round.insert(0, "user".into());
        c.exchanges.push(historical);
    }
    let mut followup = c.exchanges[0].clone();
    let mut questions = questions();
    questions.sort_all_objects();
    let mut answer = super::answer();
    answer.sort_all_objects();
    followup.request.key.user_request =
        format!("Answers to your deferred questions: {questions} {answer}");
    followup.request.key.round = vec![];
    followup.response = c.exchanges[1].response.clone();
    c.exchanges.push(followup);
    Ok(c)
}
fn response(item: &Value) -> ResponseRecord {
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
