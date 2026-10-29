use super::*;

pub(super) fn sequence(
    script: &Script,
    body: &Value,
    outputs: &[Value],
) -> Vec<(&'static str, Value)> {
    let key = butler_e2e::e2e::matching::key(
        "/codex/responses",
        body,
        &butler_e2e::e2e::sanitize::Placeholders::default(),
    );
    let instructions = body["instructions"].as_str().unwrap_or_default();
    let worker = key.user_request.starts_with("role: worker");
    let steward = key.user_request.starts_with("role: steward")
        || instructions.contains("You run one delegated Work for Butler");
    let returning = key.user_request.starts_with("Delegated result");
    let work = outputs
        .iter()
        .rev()
        .find_map(|v| {
            v.pointer("/output/work/work_id")
                .or_else(|| v.pointer("/work/work_id"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let done = json!([{"action_key":"verify","status":"done"}]);
    let review = |subject| {
        (
            "record_work_review",
            json!({"subject":subject,"verdict":"accept","summary":"Evidence verified"}),
        )
    };
    let epics = script.epics.lock().unwrap().clone();
    let selected = key
        .user_request
        .strip_prefix("canon:epic/")
        .filter(|id| epics.iter().any(|e| e == id))
        .unwrap_or(&epics[0]);
    if !worker && !steward {
        return if returning {
            vec![]
        } else {
            vec![(
                "delegate_to_steward",
                json!({
                    "request":"Verify release evidence", "safe_title":"Evidence review",
                    "checks":["Evidence verified"],
                    "epic_ref":format!("canon:epic/{}", selected)
                }),
            )]
        };
    }
    let mut calls = Vec::new();
    if !returning {
        let mode = if worker {
            "direct"
        } else if steward {
            "workers"
        } else {
            "steward"
        };
        let refs = if !worker && !steward {
            json!([format!("canon:epic/{}", selected)])
        } else {
            json!([])
        };
        calls.push(("replace_work_plan",json!({"objective":"Verify release evidence","execution_mode":mode,"governing_refs":refs,"actions":[{"action_key":"verify","description":"Verify release evidence"}],"checks":["Evidence verified"]})));
        calls.push(review("plan"));
        if worker {
            calls.push(("read_file", json!({"path":*script.path.lock().unwrap()})));
        } else {
            calls.push(("delegate_to_worker",json!({"action_key":"verify","objective":"Verify release evidence","implementation_brief":"Read the evidence and report it","acceptance_criteria":["Evidence verified"],"safe_title":"Evidence check"})));
            calls.push(("wait_for_worker", json!({})));
        }
    }
    calls.push(("record_work_checkpoint",json!({"action_updates":done,"public_summary":"Evidence verified","next_step":"Review evidence"})));
    calls.push(review("result"));
    calls.push(review("completion"));
    calls.push(("record_work_disposition",json!({"work_id":work,"disposition":"completed","summary":"Evidence verified","action_updates":done,"remaining_actions":[],"followups":[]})));
    calls
}

pub(super) fn returning_steward(body: &Value) -> bool {
    let key = butler_e2e::e2e::matching::key(
        "/codex/responses",
        body,
        &butler_e2e::e2e::sanitize::Placeholders::default(),
    );
    key.user_request.starts_with("Delegated result")
        && body["instructions"]
            .as_str()
            .unwrap_or_default()
            .contains("You run one delegated Work for Butler")
}
