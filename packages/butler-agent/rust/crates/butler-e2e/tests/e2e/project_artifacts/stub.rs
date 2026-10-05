use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
};
use serde_json::{Value, json};

// Only scheduled briefings are handled here; artifact turns stay strict replay.
pub(super) fn briefing_response(request: &Value) -> Option<ResponseRecord> {
    let raw = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str())?;
    let task: Value = serde_json::from_str(raw).ok()?;
    let kind = match task["task"].as_str()? {
        "general_new_chat_briefing" => "current_interest",
        "project_new_chat_briefing" => "project_status",
        _ => return None,
    };
    let content = json!({"moment":"Today","title":"Welcome","description":"Topics to discuss",
        "suggestions":(0..4).map(|n|json!({"id":format!("topic-{n}"),"title":format!("Topic {n}"),
            "description":"Explore","text":"Discuss this topic","source_kind":kind})).collect::<Vec<_>>(),
        "title_variants":{"morning":"Welcome","afternoon":"Welcome","evening":"Welcome","night":"Welcome"}});
    Some(response(
        &json!({"type":"message","id":"msg_artifact_briefing","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":content.to_string(),"annotations":[]}]}),
    ))
}

pub(super) fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    add(
        &mut cassette,
        &template,
        "Publish",
        "run_command",
        &json!({
            "command":"git --version","summary":"Publish file","state_effect":"read_only",
            "output_paths":["artifacts/generated/accepted.txt"]
        }),
        "Published accepted.txt.",
    );
    for prompt in ["Find", "Other", "General", "Latest", "Gone"] {
        add(
            &mut cassette,
            &template,
            prompt,
            "project_artifacts",
            &json!({"name":"accepted.txt"}),
            if matches!(prompt, "Find" | "Latest") {
                "accepted.txt from session {{ORIGIN_SESSION}}, turn {{ORIGIN_TURN}}."
            } else {
                "No matching project artifact."
            },
        );
    }
    for prompt in [
        "Open",
        "Stale",
        "Missing",
        "Deleted",
        "Foreign",
        "Symlink",
        "Oversized",
    ] {
        add(
            &mut cassette,
            &template,
            prompt,
            "project_artifacts",
            &json!({
                "read_handle":{"id":"{{FILE_ID}}","revision":"{{REVISION}}"}
            }),
            "Artifact read checked.",
        );
    }
    add(
        &mut cassette,
        &template,
        "Continue",
        "project_artifacts",
        &json!({
            "read_handle":{"id":"{{FILE_ID}}","revision":"{{REVISION}}"}, "cursor":"{{READ_CURSOR}}"
        }),
        "Opened the next page.",
    );
    add(
        &mut cassette,
        &template,
        "Forged",
        "project_artifacts",
        &json!({"project_id":"foreign"}),
        "Done.",
    );
    for prompt in [
        "Page1",
        "Page2",
        "Page3",
        "Page4",
        "Changed",
        "LongFirst",
        "Long",
    ] {
        let mut args = json!({"name":"needle", "type":"text/plain", "limit":100});
        if !matches!(prompt, "Page1" | "LongFirst") {
            args["cursor"] = json!("{{CURSOR}}");
        }
        add(
            &mut cassette,
            &template,
            prompt,
            "project_artifacts",
            &args,
            "Listed all matches on this page.",
        );
    }
    Ok(cassette)
}

fn add(
    c: &mut Cassette,
    template: &Cassette,
    prompt: &str,
    tool: &str,
    args: &Value,
    answer: &str,
) {
    // Explicit reads can split historical context into several user messages.
    for history in 0..=8 {
        let mut first = template.exchanges[0].clone();
        first.request.key.user_request = prompt.into();
        first.request.key.round = vec!["user".into(); history];
        first.response = response(
            &json!({"type":"function_call","id":"fc_artifact", "call_id":"call_artifact",
            "name":tool,"arguments":args.to_string(),"status":"completed"}),
        );
        let mut last = template.exchanges[1].clone();
        last.request.key.user_request = prompt.into();
        last.request
            .key
            .round
            .splice(0..0, vec!["user".into(); history]);
        last.response = response(
            &json!({"type":"message","id":"msg_artifact","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":answer,"annotations":[]}]}),
        );
        c.exchanges.extend([first, last]);
    }
}

fn response(item: &Value) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_artifact","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_artifact","object":"response","status":"completed",
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
