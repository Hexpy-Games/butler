use super::Research;
use crate::steward_presentation::stub::call;
use serde_json::{Value, json};

impl Research {
    pub(super) fn open(
        &mut self,
        urls: &[Value],
        tools: &[Value],
        outputs: &[Value],
    ) -> Vec<Value> {
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
    pub(super) fn invoke(
        &mut self,
        tools: &[Value],
        _outputs: &[Value],
        name: &str,
        args: &Value,
    ) -> Value {
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
pub(super) fn schema(tools: &[Value], outputs: &[Value], name: &str) -> Value {
    if let Some(tool) = tools.iter().find(|t| t["name"] == name) {
        return tool["parameters"].clone();
    }
    fn find(value: &Value, id: &str) -> Option<Value> {
        if value["id"] == id || value["name"] == id.trim_start_matches("native:") {
            for key in ["parameters", "input_schema", "schema"] {
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

pub(super) fn opened_tab(outputs: &[Value], url: &str) -> Option<Value> {
    outputs
        .iter()
        .flat_map(|o| {
            o["tabs"]
                .as_array()
                .map_or_else(|| std::slice::from_ref(o), Vec::as_slice)
        })
        .rev()
        .find(|t| t["untrusted_content"]["url"] == url || t["url"] == url)
        .and_then(|t| t["tab"].as_str().map(|s| json!(s)))
}
