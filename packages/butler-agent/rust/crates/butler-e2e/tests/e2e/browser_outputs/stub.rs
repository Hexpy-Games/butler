use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};

pub(crate) fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut c = Cassette::load("TOOL-01")?;
    c.exchanges.clear();
    for history in 0..=12 {
        for (prompt, path) in [
            ("Feature gate", "site"),
            ("Publish", "site"),
            ("Again", "site"),
            ("Fix", "site"),
            ("Checks", "site"),
            ("Images", "site"),
            ("Traversal", "../escape"),
            ("Symlink", "linked"),
            ("Many", "many"),
            ("Large", "large"),
            ("Spaced", "site/space +%.html"),
        ] {
            let mut steps = Vec::new();
            if prompt == "Feature gate" {
                steps.push(("tool_search", json!({"query":"output_","limit":50})));
                steps.push((
                    "tool_describe",
                    json!({"ids":["native:output_check","native:output_publish"]}),
                ));
            }
            if prompt == "Publish" {
                steps.push(("write_file",json!({"path":"site/index.html","content":"<!doctype html><h1>Output</h1><script src='./app.js'></script>","create_parents":true})));
                steps.push(("write_file",json!({"path":"site/app.js","content":"localStorage.setItem('output','ready');document.querySelector('h1').textContent='Ready';","create_parents":true})));
            }
            if prompt == "Fix" {
                steps.push(("write_file",json!({"path":"site/index.html","content":"<!doctype html><h1>Fixed</h1>","create_parents":true})));
            }
            if prompt == "Checks" || prompt == "Images" {
                use sha2::{Digest, Sha256};
                let id = format!("{:x}", Sha256::digest(b"general\0site"));
                steps.push(("tool_search", json!({"query":"output_check"})));
                steps.push(("tool_describe", json!({"id":"native:output_check"})));
                for _ in 0..if prompt == "Images" { 4 } else { 7 } {
                    steps.push((
                        "tool_call",
                        json!({"id":"native:output_check","arguments":{"output_id":id,"include_image":prompt == "Images"}}),
                    ));
                }
            } else if prompt != "Feature gate" {
                steps.push(("output_publish", json!({"path":path,"title":if prompt == "Spaced" { "출".repeat(200) } else { "Output".into() }})));
            }
            let mut round = vec!["user".to_owned(); history];
            for (index, (tool, args)) in steps.iter().enumerate() {
                let mut exchange = template.exchanges[0].clone();
                exchange.request.key.user_request = prompt.into();
                exchange.request.key.round = round.clone();
                exchange.response = response(
                    &json!({"type":"function_call","id":format!("fc_output_{index}"),"call_id":format!("call_output_{index}"),"name":tool,"arguments":args.to_string(),"status":"completed"}),
                );
                c.exchanges.push(exchange);
                round.extend(["function_call".into(), "function_call_output".into()]);
            }
            let mut last = template.exchanges[1].clone();
            last.request.key.user_request = prompt.into();
            last.request.key.round = round;
            last.response = response(
                &json!({"type":"message","id":"msg_output","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Published.","annotations":[]}]}),
            );
            c.exchanges.push(last);
        }
    }
    Ok(c)
}
fn response(item: &Value) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_output","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_output","object":"response","status":"completed","model":"gpt-6-sol","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
