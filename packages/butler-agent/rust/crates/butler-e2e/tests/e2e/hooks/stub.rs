//! Responses emitted entirely in process, with no live provider access.
use butler_e2e::e2e::cassette::{Chunk, ResponseRecord};
use serde_json::{Value, json};
pub(super) fn command(body: &Value) -> Option<ResponseRecord> {
    let described = body["input"]
        .as_array()?
        .iter()
        .any(|item| item["type"] == "function_call_output" && item["call_id"] == "hook_describe");
    if !described {
        return Some(response(
            &json!({"type":"function_call","id":"hook_describe","call_id":"hook_describe","name":"tool_describe","arguments":json!({"ids":["native:run_command"]}).to_string(),"status":"completed"}),
        ));
    }
    tool(
        body,
        "tool_call",
        &json!({"id":"native:run_command","arguments":command_args()}),
    )
}
fn command_args() -> Value {
    let command = if butler_platform::command_sandbox::POSIX_SHELL {
        "printf ran > \"$HOME/tool-ran\""
    } else {
        "echo ran > \"%USERPROFILE%\\tool-ran\""
    };
    json!({"command":command,"summary":"Hook check","state_effect":"read_only","timeout_ms":30000})
}
pub(super) fn large(body: &Value) -> Option<ResponseRecord> {
    tool(
        body,
        "read_file",
        &json!({"requests":[{"path":"large-a.txt","max_bytes":1_048_576},{"path":"large-b.txt","max_bytes":1_048_576}],"max_total_bytes":4_194_304}),
    )
}
fn tool(body: &Value, name: &str, arguments: &Value) -> Option<ResponseRecord> {
    let has_result = body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|item| item["type"] == "function_call_output" && item["call_id"] == "call_hooks");
    let item = if has_result {
        json!({"type":"message","id":"msg_hooks","role":"assistant","status":"completed","phase":"final_answer",
            "content":[{"type":"output_text","text":"Handled tool feedback.","annotations":[]}]})
    } else {
        json!({"type":"function_call","id":"fc_hooks","call_id":"call_hooks","name":name,
            "arguments":arguments.to_string(),"status":"completed"})
    };
    Some(response(&item))
}
pub(super) fn wallpaper(body: &Value) -> Option<ResponseRecord> {
    wallpaper_round(body, true)
}
pub(super) fn wallpaper_readonly(body: &Value) -> Option<ResponseRecord> {
    wallpaper_round(body, false)
}
fn wallpaper_round(body: &Value, work: bool) -> Option<ResponseRecord> {
    let inputs = body["input"].as_array()?;
    let done = |id: &str| {
        inputs
            .iter()
            .any(|i| i["type"] == "function_call_output" && i["call_id"] == id)
    };
    let work_id = inputs
        .iter()
        .filter_map(|i| i["output"].as_str())
        .filter_map(|o| serde_json::from_str::<Value>(o).ok())
        .find_map(|v| work_id(&v));
    let (id, name, args) = if !done("hook_describe") {
        (
            "hook_describe",
            "tool_describe",
            json!({"ids":["native:set_wallpaper"]}),
        )
    } else if work && !done("hook_start") {
        (
            "hook_start",
            "start_work",
            json!({"objective":"Set Silk wallpaper"}),
        )
    } else if work && !done("hook_plan") {
        (
            "hook_plan",
            "replace_work_plan",
            json!({"objective":"Set Silk wallpaper","execution_mode":"direct","actions":[{"action_key":"wallpaper","effect":{"capability":"set_wallpaper","target":"App wallpaper"}}],"checks":["Wallpaper is Silk"]}),
        )
    } else if work && !done("hook_review") {
        (
            "hook_review",
            "record_work_review",
            json!({"subject":"plan","verdict":"accept","summary":"User requested wallpaper","action_updates":[{"action_key":"wallpaper","status":"active"}]}),
        )
    } else if !done("call_hooks") {
        (
            "call_hooks",
            "tool_call",
            json!({"id":"native:set_wallpaper","arguments":{"scope":"global","source":{"kind":"live","module":"butler.silk"}}}),
        )
    } else if work && !done("hook_close") {
        (
            "hook_close",
            "record_work_disposition",
            json!({"work_id":work_id?,"disposition":"completed","summary":"Wallpaper applied","action_updates":[{"action_key":"wallpaper","status":"done"}]}),
        )
    } else {
        return Some(response(
            &json!({"type":"message","id":"msg_hooks","role":"assistant","status":"completed","phase":"final_answer","content":[{"type":"output_text","text":"Handled tool feedback.","annotations":[]}]}),
        ));
    };
    Some(response(
        &json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"}),
    ))
}
fn work_id(value: &Value) -> Option<String> {
    if let Some(id) = value.get("work_id").and_then(Value::as_str) {
        return Some(id.into());
    }
    if let Some(object) = value.as_object() {
        return object.values().find_map(work_id);
    }
    None
}
fn response(item: &Value) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_hooks","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":"Handled tool feedback."}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_hooks","object":"response","status":"completed",
        "model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
                    text: format!(
                        "event: {}\ndata: {e}\n\n",
                        e["type"].as_str().unwrap_or_default()
                    ),
                }
            })
            .collect(),
    }
}
