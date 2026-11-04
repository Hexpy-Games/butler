mod read;
#[cfg(test)]
mod tests;
mod tools;

use super::policy::{output_text, outputs};
use crate::steward_presentation::stub::call;
use read::Read;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use tools::schema;

#[derive(Default, serde::Serialize)]
pub(super) struct Research {
    plan: Option<Vec<Value>>,
    step: usize,
    sequence: usize,
    pending: bool,
    reads: BTreeMap<String, Read>,
    latest_results: Vec<Value>,
    received: HashSet<String>,
    described: HashSet<String>,
    pub(super) unreadable: BTreeMap<String, Value>,
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
        self.plan
            .get_or_insert_with(|| steps.as_array().expect("research steps").clone());
        let outputs = outputs(body);
        let fresh = self.fresh(body);
        self.update(&fresh, spec, evidence);
        if self.pending {
            if self.plan.as_ref().unwrap()[self.step]["search"].is_string() {
                self.latest_results = outputs
                    .iter()
                    .rev()
                    .find_map(|o| o["results"].as_array())
                    .cloned()
                    .unwrap_or_default();
            }
            self.step += 1;
            self.pending = false;
        }
        self.advance(tools, &outputs, spec, evidence)
    }
    fn advance(
        &mut self,
        tools: &[Value],
        outputs: &[Value],
        spec: &Value,
        evidence: &BTreeMap<usize, String>,
    ) -> Option<Vec<Value>> {
        while self.step < self.plan.as_ref().unwrap().len() {
            let step = self.plan.as_ref().unwrap()[self.step].clone();
            if step["open"].is_array() && !tools.iter().any(|t| t["name"] == "browser_open") {
                self.step += 1;
                continue;
            }
            let name = if step["search"].is_string() {
                "web_search"
            } else if step["open"].is_array() {
                "browser_open"
            } else if tools.iter().any(|t| t["name"] == "browser_read") {
                "browser_read"
            } else {
                "web_read"
            };
            if schema(tools, outputs, name).is_null()
                && self.described.insert(name.into())
                && tools.iter().any(|t| t["name"] == "tool_describe")
            {
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
                    outputs,
                    "web_search",
                    &json!({"query":query}),
                )]);
            }
            if let Some(urls) = step["open"].as_array() {
                self.pending = true;
                return Some(self.open(urls, tools, outputs));
            }
            assert!(step["read"].is_string(), "unknown research step");
            let end = self.plan.as_ref().unwrap()[self.step..]
                .iter()
                .position(|s| !s["read"].is_string())
                .map_or(self.plan.as_ref().unwrap().len(), |n| self.step + n);
            let group = self.plan.as_ref().unwrap()[self.step..end].to_vec();
            let calls = self.read(&group, tools, outputs);
            if !calls.is_empty() {
                return Some(calls);
            }
            if self.expand(&group, spec, evidence) {
                continue;
            }
            self.step = end;
        }
        None
    }
    fn fresh(&mut self, body: &Value) -> Vec<Value> {
        body["input"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["type"] == "function_call_output")
            .filter(|i| self.received.insert(i["call_id"].as_str().unwrap().into()))
            .filter_map(|i| serde_json::from_str::<Value>(&output_text(i)).ok())
            .map(|v| v.get("output").cloned().unwrap_or(v))
            .collect()
    }
    fn expand(
        &mut self,
        group: &[Value],
        spec: &Value,
        evidence: &BTreeMap<usize, String>,
    ) -> bool {
        for step in group {
            let url = step["read"].as_str().unwrap();
            let read = self.reads.get_mut(url).unwrap();
            if read.expanded
                || step["fallback_extra"] == true
                || self.unreadable.contains_key(url)
                || !read::missing(spec, evidence, url)
            {
                continue;
            }
            read.expanded = true;
            let mut seen = HashSet::new();
            let urls: Vec<_> = self
                .latest_results
                .iter()
                .filter_map(|r| r["url"].as_str())
                .filter(|u| !self.reads.contains_key(*u) && seen.insert((*u).to_owned()))
                .map(|u| json!(u))
                .collect();
            if urls.is_empty() {
                continue;
            }
            let mut extra = vec![json!({"open":urls})];
            extra.extend(
                urls.iter()
                    .map(|u| json!({"read":u,"query":step["query"],"fallback_extra":true})),
            );
            self.plan
                .as_mut()
                .unwrap()
                .splice(self.step..self.step, extra);
            return true;
        }
        false
    }
}
