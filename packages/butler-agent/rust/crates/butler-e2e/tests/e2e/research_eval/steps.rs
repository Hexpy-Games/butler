use super::policy::outputs;
use crate::steward_presentation::stub::call;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Research {
    step: usize,
    sequence: usize,
    pending: bool,
    reads: BTreeMap<String, Read>,
}
#[derive(Default)]
struct Read {
    started: bool,
    done: bool,
    next: Option<u64>,
    last: String,
    count: usize,
}
impl Research {
    pub(super) fn next(
        &mut self,
        steps: &Value,
        body: &Value,
        tools: &[Value],
        spec: &Value,
        evidence: &BTreeMap<usize, String>,
    ) -> Option<Vec<Value>> {
        let steps = steps.as_array().expect("research steps");
        let outputs = outputs(body);
        let browsing = tools.iter().any(|t| t["name"] == "browser_open");
        self.update(&outputs, spec, evidence);
        if self.pending {
            self.step += 1;
            self.pending = false;
        }
        while self.step < steps.len() {
            let step = &steps[self.step];
            if step["open"].is_array() && !browsing {
                self.step += 1;
                continue;
            }
            let name = if step["search"].is_string() {
                "web_search"
            } else if step["open"].is_array() {
                "browser_open"
            } else {
                "web_read"
            };
            if !tools.iter().any(|t| t["name"] == name) && schema(tools, &outputs, name).is_null() {
                self.sequence += 1;
                return Some(vec![call(
                    &format!("describe-{}", self.sequence),
                    "tool_describe",
                    &json!({"ids":[format!("native:{name}")]}),
                )]);
            }
            if let Some(query) = step["search"].as_str() {
                self.pending = true;
                return Some(vec![self.invoke(
                    tools,
                    &outputs,
                    "web_search",
                    &json!({"query":query}),
                )]);
            }
            if let Some(urls) = step["open"].as_array() {
                self.pending = true;
                return Some(self.open(urls, tools, &outputs));
            }
            assert!(step["read"].is_string(), "unknown research step");
            let end = steps[self.step..]
                .iter()
                .position(|s| !s["read"].is_string())
                .map_or(steps.len(), |n| self.step + n);
            let calls = self.read(&steps[self.step..end], tools, &outputs, browsing);
            if !calls.is_empty() {
                return Some(calls);
            }
            self.step = end;
        }
        None
    }
    fn open(&mut self, urls: &[Value], tools: &[Value], outputs: &[Value]) -> Vec<Value> {
        let results = outputs
            .iter()
            .filter_map(|o| o["results"].as_array())
            .flatten()
            .collect::<Vec<_>>();
        let mut ids = Vec::new();
        let mut calls = Vec::new();
        for url in urls {
            if let Some(result) = results.iter().rev().find(|r| r["url"] == *url) {
                ids.push(result["id"].clone());
            } else {
                calls.push(self.invoke(tools, outputs, "browser_open", &json!({"url":url})));
            }
        }
        if !ids.is_empty() {
            calls.insert(
                0,
                self.invoke(tools, outputs, "browser_open", &json!({"results":ids})),
            );
        }
        calls
    }
    fn read(
        &mut self,
        group: &[Value],
        tools: &[Value],
        outputs: &[Value],
        browsing: bool,
    ) -> Vec<Value> {
        let pending = group
            .iter()
            .filter(|s| {
                !self
                    .reads
                    .get(s["read"].as_str().unwrap())
                    .is_some_and(|r| r.done)
            })
            .collect::<Vec<_>>();
        let first = pending.iter().any(|s| {
            !self
                .reads
                .get(s["read"].as_str().unwrap())
                .is_some_and(|r| r.started)
        });
        let mut calls = Vec::new();
        for step in pending {
            let url = step["read"].as_str().unwrap();
            let read = self.reads.entry(url.into()).or_default();
            if first && read.started {
                continue;
            }
            let mut args = if browsing {
                let tab = opened_tab(outputs, url);
                json!({"tab":tab})
            } else {
                json!({"url":url})
            };
            if read.started {
                args["start_chunk"] = json!(read.next.expect("continuation cursor"));
            }
            if schema(tools, outputs, "web_read")
                .pointer("/properties/query")
                .is_some()
                && step["query"].is_string()
            {
                args["query"] = step["query"].clone();
            }
            read.started = true;
            calls.push(self.invoke(tools, outputs, "web_read", &args));
        }
        calls
    }
    fn update(&mut self, outputs: &[Value], spec: &Value, evidence: &BTreeMap<usize, String>) {
        for (url, read) in &mut self.reads {
            let windows = outputs
                .iter()
                .filter(|o| o["source_url"] == *url && o.get("next_start_chunk").is_some())
                .collect::<Vec<_>>();
            if windows.len() <= read.count {
                read.done |= read.started;
                continue;
            }
            read.count = windows.len();
            let last = windows.last().unwrap();
            let text = last["markdown"]
                .as_str()
                .or(last["text"].as_str())
                .unwrap_or_default();
            read.next = last["next_start_chunk"].as_u64();
            read.done = text.is_empty()
                || read.last.contains(text)
                || read.next.is_none()
                || spec["facts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| f["page"] == *url)
                    .all(|(i, _)| evidence.contains_key(&i));
            read.last.push_str(text);
            read.last.push('\n');
        }
    }
    fn invoke(&mut self, tools: &[Value], _outputs: &[Value], name: &str, args: &Value) -> Value {
        self.sequence += 1;
        let id = format!("research-{}", self.sequence);
        if tools.iter().any(|t| t["name"] == name) {
            return call(&id, name, args);
        }
        assert!(
            tools.iter().any(|t| t["name"] == "tool_call"),
            "required generic tool unavailable"
        );
        call(
            &id,
            "tool_call",
            &json!({"id":format!("native:{name}"),"arguments":args}),
        )
    }
}
fn schema(tools: &[Value], outputs: &[Value], name: &str) -> Value {
    if let Some(tool) = tools.iter().find(|t| t["name"] == name) {
        return tool["parameters"].clone();
    }
    fn find(value: &Value, id: &str) -> Option<Value> {
        if value["id"] == id || value["name"] == id.trim_start_matches("native:") {
            for key in ["parameters", "input_schema"] {
                if value[key].is_object() {
                    return Some(value[key].clone());
                }
            }
        }
        match value {
            Value::Array(a) => a.iter().find_map(|v| find(v, id)),
            Value::Object(o) => o.values().find_map(|v| find(v, id)),
            _ => None,
        }
    }
    outputs
        .iter()
        .rev()
        .find_map(|o| find(o, &format!("native:{name}")))
        .unwrap_or(Value::Null)
}

fn opened_tab(outputs: &[Value], url: &str) -> Value {
    outputs
        .iter()
        .flat_map(|o| {
            o["tabs"]
                .as_array()
                .map_or_else(|| std::slice::from_ref(o), Vec::as_slice)
        })
        .rev()
        .find(|t| t["untrusted_content"]["url"] == url || t["url"] == url)
        .unwrap_or_else(|| {
            panic!(
                "opened tab missing; tool result shapes: {:?}",
                outputs
                    .iter()
                    .map(|o| (
                        o["status"].clone(),
                        o["reason"].clone(),
                        o.as_object().map(|v| v.keys().collect::<Vec<_>>())
                    ))
                    .collect::<Vec<_>>()
            )
        })["tab"]
        .clone()
}
