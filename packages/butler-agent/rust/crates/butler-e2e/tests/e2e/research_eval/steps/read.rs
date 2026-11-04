use super::{
    Research,
    tools::{opened_tab, schema},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default, PartialEq, Eq, serde::Serialize)]
enum Pass {
    #[default]
    Query,
    Ordered,
    Extra,
}
#[derive(Default, PartialEq, Eq, serde::Serialize)]
enum Status {
    #[default]
    New,
    Awaiting,
    Continuing,
    Done,
}
#[derive(Default, serde::Serialize)]
pub(super) struct Read {
    pub(super) expanded: bool,
    pass: Pass,
    status: Status,
    next: Option<u64>,
    last: String,
    count: usize,
    end_reason: String,
}
impl Research {
    pub(super) fn read(
        &mut self,
        group: &[Value],
        tools: &[Value],
        outputs: &[Value],
    ) -> Vec<Value> {
        let browsing = tools.iter().any(|t| t["name"] == "browser_open");
        let reader = if tools.iter().any(|t| t["name"] == "browser_read") {
            "browser_read"
        } else {
            "web_read"
        };
        let contract = schema(tools, outputs, reader);
        let mut calls = Vec::new();
        for step in group {
            let url = step["read"].as_str().unwrap();
            let read = self.reads.entry(url.into()).or_default();
            if read.status == Status::Done {
                continue;
            }
            let tab = opened_tab(outputs, url);
            if contract.is_null()
                || (tab.is_none() && (browsing || contract.pointer("/properties/url").is_none()))
            {
                read.status = Status::Done;
                let reason = if contract.is_null() {
                    "No page reader in offered tools and discovery."
                } else {
                    "No usable tab received for this page; the offered browser/reader tools cannot address it."
                };
                self.unreadable.insert(
                    url.into(),
                    json!({"reason":reason,
                    "web_read_schema":contract,"browser_open_offered":browsing,
                    "offered_tools":tools.iter().map(|t|t["name"].clone()).collect::<Vec<_>>()}),
                );
                continue;
            }
            let mut args = if browsing || tab.is_some() {
                json!({"tab":tab.expect("opened tab")})
            } else {
                json!({"url":url})
            };
            if read.pass == Pass::Ordered || read.status != Status::New {
                args["start_chunk"] = json!(read.next.unwrap_or(0));
            }
            if read.pass != Pass::Ordered
                && contract.pointer("/properties/query").is_some()
                && step["query"].is_string()
            {
                args["query"] = step["query"].clone();
            }
            if step["fallback_extra"] == true {
                read.pass = Pass::Extra;
            }
            read.status = Status::Awaiting;
            calls.push(self.invoke(tools, outputs, reader, &args));
        }
        calls
    }
    pub(super) fn update(
        &mut self,
        fresh: &[Value],
        spec: &Value,
        evidence: &BTreeMap<usize, String>,
    ) {
        for (url, read) in &mut self.reads {
            if read.status != Status::Awaiting {
                continue;
            }
            read.status = Status::Continuing;
            read.count += 1;
            let last = fresh.iter().rev().find(|o| o["source_url"] == *url);
            let text = last
                .and_then(|o| o["markdown"].as_str().or(o["text"].as_str()))
                .unwrap_or_default();
            read.next = last.and_then(|o| o["next_start_chunk"].as_u64());
            let missing = missing(spec, evidence, url);
            read.end_reason = if !missing {
                "facts_received"
            } else if text.is_empty() {
                "empty_or_unchanged"
            } else if read.last.contains(text) {
                "no_new_text"
            } else if read.next.is_none() {
                "exhausted"
            } else {
                ""
            }
            .into();
            read.last.push_str(text);
            read.last.push('\n');
            if read.end_reason.is_empty() {
                continue;
            }
            if missing && read.pass == Pass::Query {
                read.pass = Pass::Ordered;
                read.status = Status::New;
                read.next = Some(0);
                read.last.clear();
            } else {
                read.status = Status::Done;
            }
        }
    }
}
pub(super) fn missing(spec: &Value, evidence: &BTreeMap<usize, String>, url: &str) -> bool {
    spec["facts"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .any(|(i, f)| f["page"] == url && !evidence.contains_key(&i))
}
