use super::*;

impl Run {
    pub(super) fn remember(&mut self, view: Value) {
        let url = view["untrusted_content"]["url"]
            .as_str()
            .or(view["source_url"].as_str())
            .unwrap_or("")
            .to_owned();
        let text = view["untrusted_content"]["text"]
            .as_str()
            .or(view["markdown"].as_str())
            .unwrap_or("");
        self.seen.push((url.clone(), text.to_owned()));
        self.url = json!(url);
        if let Some(obs) = view.get("obs") {
            self.observation = obs.clone();
        }
        self.view = view;
    }

    pub(super) fn finish(&self, mut result: Value, model: &str) -> Value {
        if !matches!(
            result["status"].as_str(),
            Some("done" | "stuck" | "needs_approval" | "step_limit" | "executor_unavailable")
        ) {
            result["summary"] = json!({"status":result["status"],"reason":result["reason"]});
            result["status"] = json!("stuck");
        }
        if result.get("summary").is_none() {
            result["summary"] = result["reason"].clone();
        }
        result["tab"] = self.tab.clone();
        result["url"] = self.url.clone();
        result["opened_tabs"] = json!(self.opened);
        result["steps_used"] = json!(self.steps);
        result["executor_model"] = json!(model);
        if result.get("fields").is_none() {
            result["fields"] = json!({});
        }
        if result.get("evidence").is_none() {
            result["evidence"] = json!([]);
        }
        result
    }
}

pub(super) fn terminal(run: &Run, next: &Value) -> Option<Value> {
    if let Some(done) = next.get("done") {
        return Some(verified(run, done));
    }
    if let Some(stuck) = next.get("stuck") {
        return Some(json!({"status":"stuck","summary":stuck["reason"],"needs":stuck["needs"]}));
    }
    next.get("approve").map(|approve| {
        json!({"status":"needs_approval","summary":approve["action"],
        "handoff":{"tab":run.tab,"observation":run.observation,"steps":approve["steps"]}})
    })
}

fn verified(run: &Run, done: &Value) -> Value {
    let mut fields = done["fields"].as_object().cloned().unwrap_or_default();
    for field in run
        .fields
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        fields.entry(field).or_insert(Value::Null);
    }
    let mut evidence = Vec::new();
    let mut unverified = std::collections::BTreeSet::new();
    for item in done["evidence"].as_array().into_iter().flatten() {
        let field = item["field"].as_str().unwrap_or("");
        let quote = item["quote"].as_str().unwrap_or("");
        let source = run
            .seen
            .iter()
            .find(|(_, text)| !quote.is_empty() && text.contains(quote));
        if let Some((url, _)) = source {
            evidence.push(json!({"field":field,"quote":quote,"url":url}));
        } else {
            unverified.insert(field.to_owned());
        }
    }
    for (field, value) in &fields {
        if !value.is_null() && !evidence.iter().any(|item| item["field"] == *field) {
            unverified.insert(field.clone());
        }
    }
    json!({"status":"done","fields":fields,"evidence":evidence,"unverified":unverified,"summary":done["summary"]})
}
