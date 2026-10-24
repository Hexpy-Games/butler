use super::*;

pub(super) fn parse(text: &str) -> Result<(String, Value), &'static str> {
    let value: Value = serde_json::from_str(text).map_err(|_| "invalid_executor_json")?;
    let object = value.as_object().ok_or("invalid_executor_json")?;
    if object.len() != 2 {
        return Err("invalid_executor_response");
    }
    let notes = value["notes"].as_str().ok_or("invalid_executor_notes")?;
    if notes.chars().count() > 2_000 {
        return Err("executor_notes_too_long");
    }
    let next = value["next"].as_object().ok_or("invalid_executor_next")?;
    if next.len() != 1
        || !next
            .keys()
            .all(|key| ["act", "open", "read", "done", "stuck", "approve"].contains(&key.as_str()))
    {
        return Err("invalid_executor_next");
    }
    let next_value = &value["next"];
    if !valid_next(next_value) {
        return Err("invalid_executor_next");
    }
    Ok((notes.into(), next_value.clone()))
}

fn call(name: &str, args: &Value) -> ModelRoundToolCall {
    ModelRoundToolCall {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        raw_arguments: args.to_string(),
        arguments: args.as_object().cloned().unwrap_or_default(),
        origin: None,
    }
}

async fn browser_call(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    occurrence: &str,
    name: &str,
    args: Value,
) -> Result<Value, ToolExecutionError> {
    let call = call(name, &args);
    let occurrence = format!("{occurrence}:{name}");
    super::journal::execute(owner, invocation, &call, &occurrence).await
}

pub(super) async fn observe(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    occurrence: &str,
    tab: &Value,
) -> Result<Value, ToolExecutionError> {
    browser_call(
        owner,
        invocation,
        occurrence,
        "browser_observe",
        json!({"tab":tab,"full":true,"look":"never"}),
    )
    .await
}

pub(super) async fn open(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    occurrence: &str,
    run: &mut Run,
    url: &Value,
) -> Result<Value, ToolExecutionError> {
    let result = browser_call(
        owner,
        invocation,
        occurrence,
        "browser_open",
        json!({"url":url}),
    )
    .await?;
    if result["status"] == "ok" {
        run.tab = result["tab"].clone();
        run.opened.push(run.tab.clone());
    }
    Ok(result)
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    occurrence: &str,
    run: &mut Run,
    next: &Value,
) -> Result<Value, ToolExecutionError> {
    if let Some(opened) = next.get("open") {
        if opened["url"].as_str().is_none() {
            return Ok(json!({"status":"invalid_url"}));
        }
        let result = open(owner, invocation, occurrence, run, &opened["url"]).await?;
        return if result["status"] == "ok" {
            observe(owner, invocation, occurrence, &run.tab).await
        } else {
            Ok(result)
        };
    }
    if let Some(read) = next.get("read") {
        let args = json!({"tab":run.tab,"query":read["query"],"start_chunk":read["start_chunk"]});
        let call = call("web_read", &args);
        return super::journal::execute(owner, invocation, &call, occurrence).await;
    }
    let steps = &next["act"]["steps"];
    if !valid_steps(steps, &run.view) {
        return Ok(json!({"status":"invalid_steps"}));
    }
    let args = json!({"tab":run.tab,"observation":run.observation,"steps":steps,"observe":false});
    let result = browser_call(owner, invocation, occurrence, "browser_act", args).await?;
    if result["status"] == "ok" {
        observe(owner, invocation, occurrence, &run.tab).await
    } else {
        Ok(result)
    }
}

fn valid_steps(steps: &Value, view: &Value) -> bool {
    let Some(steps) = steps
        .as_array()
        .filter(|steps| !steps.is_empty() && steps.len() <= 10)
    else {
        return false;
    };
    let text = view["untrusted_content"]["text"].as_str().unwrap_or("");
    steps.iter().all(|step| {
        [
            "click", "fill", "select", "scroll", "press", "type", "wait", "back", "upload",
        ]
        .iter()
        .any(|action| step["action"] == *action)
            && step.get("point").is_none()
            && step.get("target_point").is_none()
            && step.get("ref").is_none_or(|reference| {
                reference
                    .as_str()
                    .is_some_and(|reference| text.contains(&format!("[{reference}]")))
            })
    })
}

fn valid_next(next: &Value) -> bool {
    if let Some(done) = next.get("done") {
        return done["summary"].is_string()
            && done["fields"].as_object().is_some_and(|fields| {
                fields
                    .values()
                    .all(|value| value.is_null() || value.is_string())
            })
            && done["evidence"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .all(|item| item["field"].is_string() && item["quote"].is_string())
            });
    }
    if let Some(stuck) = next.get("stuck") {
        return stuck["reason"].is_string() && stuck["needs"].is_string();
    }
    if let Some(open) = next.get("open") {
        return open["url"].is_string();
    }
    if let Some(read) = next.get("read") {
        return read["query"].is_string() && read["start_chunk"].as_u64().is_some();
    }
    let action = next.get("act").or_else(|| next.get("approve"));
    action.is_some_and(|action| {
        action["steps"]
            .as_array()
            .is_some_and(|steps| !steps.is_empty() && steps.len() <= 10)
            && (next.get("approve").is_none() || action["action"].is_string())
    })
}
