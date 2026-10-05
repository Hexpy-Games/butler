use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};

pub(super) const PROMPT: &str = "다운로드 폴더 정리해줘";
pub(super) const ANSWER: &str = "다운로드 목록을 확인했습니다. 문서는 문서 폴더로, 이미지는 이미지 폴더로 분류하겠습니다. 이동 전에 승인을 받겠습니다.";

pub(super) fn cassette(command: &str) -> Result<Cassette, HarnessError> {
    let mut c = Cassette::load("TOOL-01")?;
    c.meta.model = "openai/gpt-6-luna".into();
    for e in &mut c.exchanges {
        e.request.key.user_request = PROMPT.into();
        e.request.key.model = "gpt-6-luna".into();
    }
    c.exchanges[0].response = response(
        &json!({"type":"function_call","id":"fc_command","call_id":"call_command","name":"run_command",
        "arguments":json!({"command":command,"summary":"다운로드 목록 확인","state_effect":"read_only","timeout_ms":30000}).to_string(),"status":"completed"}),
    );
    c.exchanges[1].response = response(
        &json!({"type":"message","id":"msg_answer","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":ANSWER,"annotations":[]}]}),
    );
    Ok(c)
}

pub(super) fn response(item: &Value) -> ResponseRecord {
    let completed = json!({"id":"resp_command","object":"response","status":"completed","model":"gpt-6-luna",
        "output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}});
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_command","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
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
                        event["type"].as_str().unwrap_or_default()
                    ),
                }
            })
            .collect(),
    }
}
