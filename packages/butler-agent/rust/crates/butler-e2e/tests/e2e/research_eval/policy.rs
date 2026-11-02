use super::{fixture::Task, steps::Research};
use crate::steward_presentation::stub::{call, message, review, work_id};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

#[derive(serde::Serialize)]
pub(super) struct Exchange {
    pub lane: String,
    pub body: Value,
    pub items: Vec<Value>,
    pub research: Value,
    pub evidence: BTreeMap<usize, String>,
}
#[derive(Default)]
struct Actor {
    phase: usize,
    seen: HashSet<String>,
    evidence: BTreeMap<usize, String>,
    research: Research,
    deliveries: HashSet<String>,
}
pub(super) struct Policy {
    pub task: Arc<Task>,
    actors: BTreeMap<String, Actor>,
    pub exchanges: Vec<Exchange>,
    pub answer: Option<String>,
}
impl Policy {
    pub(super) fn new(task: Arc<Task>) -> Self {
        Self {
            task,
            actors: BTreeMap::new(),
            exchanges: Vec::new(),
            answer: None,
        }
    }
    pub(super) fn reply(&mut self, body: &Value) -> Vec<Value> {
        let (lane, worker) = lane(body, &self.task.spec);
        let actor = self.actors.entry(lane.clone()).or_default();
        absorb(actor, body, &self.task.spec);
        let tools = butler_e2e::e2e::chatgpt_wire::functions(body)
            .cloned()
            .collect::<Vec<_>>();
        let mut items = if tools.is_empty() {
            vec![message("{}")]
        } else if lane == "butler" && self.task.spec["shape"] != "direct" {
            parent(actor, &self.task.spec)
        } else {
            research_actor(
                actor,
                body,
                &tools,
                &self.task.spec,
                worker,
                lane != "butler",
            )
        };
        for (index, item) in items.iter_mut().enumerate() {
            let id = format!("exchange-{}-{index}", self.exchanges.len());
            item["id"] = json!(id);
            if item["type"] == "function_call" {
                item["call_id"] = json!(id);
            }
        }
        if lane == "butler" && !tools.is_empty() && items.iter().any(|i| i["type"] == "message") {
            let delegated = self.task.spec["shape"] != "direct";
            if !delegated || delivered(body) {
                self.answer = items
                    .iter()
                    .find_map(|i| i["content"][0]["text"].as_str().map(str::to_owned));
            }
        }
        self.exchanges.push(Exchange {
            lane,
            body: body.clone(),
            items: items.clone(),
            research: json!(actor.research),
            evidence: actor.evidence.clone(),
        });
        items
    }
}
fn lane(body: &Value, spec: &Value) -> (String, Option<usize>) {
    let users = body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["role"] == "user")
        .map(crate::steward_presentation::stub::user_text)
        .collect::<Vec<_>>()
        .join("\n");
    if users.lines().any(|l| {
        l.starts_with("role: worker")
            || l.starts_with("Original request (highest priority): role: worker")
    }) {
        let worker = spec["workers"]
            .as_array()
            .unwrap()
            .iter()
            .position(|w| {
                normalized(&users).contains(&normalized(&format!(
                    "assigned_objective: {} acceptance_criteria:",
                    w["goal"].as_str().unwrap()
                )))
            })
            .expect("worker assignment in packet");
        (format!("worker-{worker}"), Some(worker))
    } else if crate::steward_presentation::stub::child_lane(body)
        || body["instructions"]
            .as_str()
            .unwrap_or("")
            .contains("You run one delegated Work for Butler")
    {
        ("steward".into(), None)
    } else {
        ("butler".into(), None)
    }
}
fn delivered(body: &Value) -> bool {
    body["input"].as_array().into_iter().flatten().any(|i| {
        i["role"] == "user"
            && crate::steward_presentation::stub::user_text(i).starts_with("Delegated result")
    })
}
fn parent(actor: &mut Actor, spec: &Value) -> Vec<Value> {
    if actor.phase == 0 {
        actor.phase = 1;
        vec![call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":spec["request"],
            "checks":["Report evidence with source URLs"]}),
        )]
    } else {
        vec![message(&evidence(actor, spec))]
    }
}
fn research_actor(
    actor: &mut Actor,
    body: &Value,
    tools: &[Value],
    spec: &Value,
    worker: Option<usize>,
    child: bool,
) -> Vec<Value> {
    let workers = child && worker.is_none() && spec["shape"] == "workers";
    let actions = actions(spec, workers);
    if child && actor.phase < 2 {
        return vec![bookkeeping(actor, spec, worker, workers, &actions)];
    }
    if workers && actor.phase == 2 {
        actor.phase = 3;
        return spec["workers"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, w)| {
                call(
                    &format!("worker-{i}"),
                    "delegate_to_worker",
                    &json!({"action_key":format!("research-{i}"),
                "objective":w["goal"],"implementation_brief":w["goal"],
                "acceptance_criteria":["Report evidence with source URLs"]}),
                )
            })
            .collect();
    }
    if workers
        && actor.phase < 5
        && actor.deliveries.len() < spec["workers"].as_array().unwrap().len()
    {
        return vec![call("wait", "wait_for_worker", &json!({}))];
    }
    if !workers {
        let steps = worker.map_or(&spec["steps"], |i| &spec["workers"][i]["steps"]);
        if let Some(items) = actor
            .research
            .next(steps, body, tools, spec, &actor.evidence)
        {
            return items;
        }
    }
    if child && actor.phase < 5 {
        actor.phase = 5;
        let updates = actions
            .iter()
            .map(|a| json!({"action_key":a["action_key"],"status":"done"}))
            .collect::<Vec<_>>();
        return vec![call(
            "close",
            "record_work_disposition",
            &json!({"work_id":work_id(body),
            "disposition":"completed","summary":evidence(actor, spec),"action_updates":updates,
            "remaining_actions":[],"followups":[]}),
        )];
    }
    vec![message(&evidence(actor, spec))]
}
fn bookkeeping(
    actor: &mut Actor,
    spec: &Value,
    worker: Option<usize>,
    workers: bool,
    actions: &[Value],
) -> Value {
    let objective = worker.map_or(&spec["request"], |i| &spec["workers"][i]["goal"]);
    let item = if actor.phase == 0 {
        call(
            "plan",
            "replace_work_plan",
            &json!({"objective":objective,
            "execution_mode":if workers {"workers"} else {"direct"},
            "actions":actions,"checks":["Report evidence with source URLs"]}),
        )
    } else {
        call("review", "record_work_review", &review())
    };
    actor.phase += 1;
    item
}
fn actions(spec: &Value, workers: bool) -> Vec<Value> {
    let count = if workers {
        spec["workers"].as_array().unwrap().len()
    } else {
        1
    };
    (0..count)
        .map(|i| {
            json!({"action_key":format!("research-{i}"),
        "description":"Gather source evidence","dependency_keys":[]})
        })
        .collect()
}
pub(super) fn normalized(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn evidence(actor: &Actor, spec: &Value) -> String {
    let lines = actor
        .evidence
        .iter()
        .map(|(i, span)| format!("{} — {}", span, spec["facts"][*i]["page"].as_str().unwrap()))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        "No matching evidence received.".into()
    } else {
        lines.join("\n")
    }
}
fn absorb(actor: &mut Actor, body: &Value, spec: &Value) {
    let mut occurrences = BTreeMap::<String, usize>::new();
    for item in body["input"].as_array().into_iter().flatten() {
        let tool = item["type"] == "function_call_output";
        let delegated = item["role"] == "user"
            && crate::steward_presentation::stub::user_text(item).starts_with("Delegated result");
        if delegated {
            let key = item.to_string();
            let occurrence = occurrences.entry(key.clone()).or_default();
            *occurrence += 1;
            actor.deliveries.insert(format!("{key}:{occurrence}"));
        }
        if !tool && !delegated {
            continue;
        }
        let raw = if tool {
            output_text(item)
        } else {
            crate::steward_presentation::stub::user_text(item)
        };
        if !actor.seen.insert(raw.clone()) {
            continue;
        }
        let decoded = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
        let page = decoded.get("output").unwrap_or(&decoded);
        let text = if delegated {
            normalized(&raw)
        } else {
            page_text(page)
        };
        for (i, fact) in spec["facts"].as_array().unwrap().iter().enumerate() {
            if let Some(span) = fact["any"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .find(|s| {
                    if delegated {
                        text.contains(&normalized(&format!(
                            "{s} — {}",
                            fact["page"].as_str().unwrap()
                        )))
                    } else {
                        page["source_url"] == fact["page"] && text.contains(&normalized(s))
                    }
                })
            {
                actor.evidence.insert(i, span.to_owned());
            }
        }
    }
}
// Only extracted text can establish evidence. Tool metadata and Work objectives
// can repeat the request, so scanning arbitrary JSON would credit unread facts.
fn page_text(page: &Value) -> String {
    let mut text = page["markdown"].as_str().unwrap_or_default().to_owned();
    for chunk in page["chunks"].as_array().into_iter().flatten() {
        text.push('\n');
        text.push_str(chunk["text"].as_str().unwrap_or_default());
    }
    format!(
        "{}\n{}",
        normalized(&text),
        normalized(&super::markup::visible(&text))
    )
}
pub(super) fn output_text(item: &Value) -> String {
    item["output"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            item["output"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
}
pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["type"] == "function_call_output")
        .filter_map(|i| serde_json::from_str::<Value>(&output_text(i)).ok())
        .map(|v| v.get("output").cloned().unwrap_or(v))
        .collect()
}
