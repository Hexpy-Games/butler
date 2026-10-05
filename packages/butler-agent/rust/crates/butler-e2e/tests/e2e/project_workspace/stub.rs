use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, Exchange, MatchKey, Meta, RequestRecord, ResponseRecord},
};
use serde_json::{Value, json};
use std::path::Path;
pub(super) const LIST: &str = "List files in this project.";
pub(super) const READ: &str = "Read the project marker.";
pub(super) const COMMAND: &str = "Run the project command, asking for approval.";
pub(super) const WRITE: &str = "Write written.txt in this project, asking for approval.";
pub(super) const DATA: &str = "Read the Butler data config with the file tool.";

pub(super) fn cassette(
    workspace: &Path,
    read: &Path,
    data: &Path,
) -> Result<Cassette, HarnessError> {
    let mut exchanges = Vec::new();
    for (index, (prompt, tool, args)) in [
        (LIST, "list_files", json!({"root":butler_platform::secure_fs::workspace_test_alias(workspace),"max_results":100})),
        (READ, "read_file", json!({"requests":[{"path":read,"max_bytes":2048}]})),
        (COMMAND, "run_command", json!({"command":"echo project-command > command.txt","cwd":butler_platform::secure_fs::workspace_test_alias(workspace),"state_effect":"mutation","summary":"Write command marker"})),
        (WRITE, "write_file", json!({"path":butler_platform::secure_fs::workspace_test_alias(&workspace.join("written.txt")),"content":"approved project write"})),
        (DATA, "read_file", json!({"requests":[{"path":butler_platform::secure_fs::workspace_test_alias(&data.join("butler.config.json")),"max_bytes":2048}]})),
    ].into_iter().enumerate() {
        let call = json!({"type":"function_call","id":format!("fc_{index}"),"call_id":format!("call_{index}"),"name":tool,"arguments":args.to_string(),"status":"completed"});
        let answer = json!({"type":"message","id":format!("msg_{index}"),"role":"assistant","status":"completed","content":[{"type":"output_text","text":"Project operation checked.","annotations":[]}]});
        let mut round = Vec::new();
        let effect = prompt == COMMAND || prompt == WRITE;
        let action = if prompt == COMMAND { "command" } else { "write" };
        if effect {
            for (step, name, arguments) in [
                (0, "start_work", json!({"objective":prompt})),
                (1, "replace_work_plan", json!({"objective":prompt,"execution_mode":"direct","actions":[{"action_key":action,"effect":{"capability":tool,"target":"project marker"}}],"checks":["Project marker contains the requested content"]})),
                (2, "record_work_review", json!({"subject":"plan","verdict":"accept","summary":"Only the approved project write","action_updates":[{"action_key":action,"status":"active"}]})),
            ] {
                let item = json!({"type":"function_call","id":format!("work_{step}"),"call_id":format!("work_{step}"),"name":name,"arguments":arguments.to_string(),"status":"completed"});
                exchanges.push(exchange(prompt, round.clone(), &item));
                round.extend(["function_call".into(),"function_call_output".into(),"user".into()]);
            }
        }
        exchanges.push(exchange(prompt, round.clone(), &call));
        round.extend(["function_call".into(),"function_call_output".into()]);
        if effect {
            let work = if prompt == COMMAND { "{{ECHO_1}}" } else { "{{ECHO_2}}" };
            let close = json!({"type":"function_call","id":format!("close_{index}"),"call_id":format!("close_{index}"),"name":"record_work_disposition","arguments":json!({"work_id":work,"disposition":"completed","summary":"Applied the approved project write","action_updates":[{"action_key":action,"status":"done"}]}).to_string(),"status":"completed"});
            exchanges.push(exchange(prompt, round.clone(), &close));
            round.extend(["function_call".into(),"function_call_output".into(),"user".into(),"user".into()]);
        }
        exchanges.push(exchange(prompt, round, &answer));
    }
    Ok(Cassette {
        scenario: "PROJECT-WORKSPACE".into(),
        meta: Meta {
            provider: "openai-subscription".into(),
            model: "openai/gpt-6-luna".into(),
            effort: Some("low".into()),
            ..Meta::default()
        },
        exchanges,
    })
}

fn exchange(prompt: &str, round: Vec<String>, item: &Value) -> Exchange {
    Exchange {
        request: RequestRecord {
            method: "POST".into(),
            path: "/codex/responses".into(),
            key: MatchKey {
                path: "/codex/responses".into(),
                model: "gpt-6-luna".into(),
                effort: Some("low".into()),
                user_request: prompt.into(),
                round,
            },
        },
        response: response(item),
    }
}

fn response(item: &Value) -> ResponseRecord {
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
