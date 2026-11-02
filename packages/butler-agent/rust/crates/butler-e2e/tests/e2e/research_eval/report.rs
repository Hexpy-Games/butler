mod render;
#[cfg(test)]
mod tests;
use super::{
    fixture::Task,
    policy::{Policy, normalized, output_text},
};
use butler_e2e::e2e::HarnessError;
pub(super) use render::markdown;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub(super) fn measure(
    task: &Task,
    set: &str,
    policy: &Policy,
    answer: &str,
) -> Result<Value, HarnessError> {
    let tokenizer = tiktoken_rs::o200k_base().map_err(|e| HarnessError(e.to_string()))?;
    let tokens = |s: &str| tokenizer.encode_ordinary(s);
    let count = |v: &Value| tokens(&v.to_string()).len();
    let pricing = pricing();
    let mut previous = HashMap::<String, Vec<u32>>::new();
    let mut calls = BTreeMap::<String, usize>::new();
    let mut requests = Vec::new();
    let mut largest = Vec::new();
    let mut seen = HashSet::new();
    let names = tool_names(policy);
    for exchange in &policy.exchanges {
        let body = &exchange.body;
        let input_items = body["input"].as_array().expect("input items");
        let mut prompt = format!("{}\n{}\n", body["instructions"], body["tools"]);
        for item in input_items {
            prompt.push_str(&item.to_string());
            prompt.push('\n');
        }
        let encoded = tokens(&prompt);
        let input = encoded.len();
        let cached = previous.get(&exchange.lane).map_or(0, |p| {
            p.iter().zip(&encoded).take_while(|(a, b)| a == b).count()
        });
        previous.insert(exchange.lane.clone(), encoded);
        let output = exchange.items.iter().map(&count).sum::<usize>();
        let uncached = input - cached;
        let (usd, usd_cold) = price(&pricing, input, cached, output);
        *calls.entry(exchange.lane.clone()).or_default() += 1;
        requests.push(json!({"lane":exchange.lane,"model":body["model"],
            "tools":count(&body["tools"]),"instructions":count(&body["instructions"]),
            "input_items":input_items.iter().map(&count).sum::<usize>(),
            "input":input,"cached":cached,"uncached":uncached,"output":output,"usd":usd,"usd_cold":usd_cold}));
        for item in input_items
            .iter()
            .filter(|i| i["type"] == "function_call_output")
        {
            let key = (
                exchange.lane.clone(),
                item["call_id"].as_str().unwrap_or_default().to_owned(),
            );
            if seen.insert(key.clone()) {
                largest.push(json!({"lane":key.0,"tool":names.get(&key),"tokens":tokens(&output_text(item)).len()}));
            }
        }
    }
    largest.sort_by_key(|v| std::cmp::Reverse(v["tokens"].as_u64().unwrap()));
    largest.truncate(5);
    let mut row = task_row(task, set, answer, &calls, &requests, &largest);
    let unreadable = policy.unreadable();
    row["unreadable_pages"] = json!(unreadable.len());
    if !super::blind(set) {
        row["unreadable"] = json!(unreadable);
    }
    Ok(row)
}
fn task_row(
    task: &Task,
    set: &str,
    answer: &str,
    calls: &BTreeMap<String, usize>,
    requests: &[Value],
    largest: &[Value],
) -> Value {
    let facts = task.spec["facts"].as_array().unwrap();
    let text = normalized(answer);
    let missed = facts
        .iter()
        .filter(|f| {
            !f["any"].as_array().unwrap().iter().any(|s| {
                text.contains(&normalized(&format!(
                    "{} — {}",
                    s.as_str().unwrap(),
                    f["page"].as_str().unwrap()
                )))
            })
        })
        .map(|f| f["id"].clone())
        .collect::<Vec<_>>();
    let mut row = json!({"id":task.spec["id"],"set":set,"shape":task.spec["shape"],
        "runtime_models":requests.iter().filter_map(|r|r["model"].as_str()).collect::<std::collections::BTreeSet<_>>(),
        "facts_found":facts.len()-missed.len(),"facts_total":facts.len(),"missed":missed,
        "calls_per_lane":calls,"calls":requests.len(),"completed":true,
        "average_tools_tokens":requests.iter().map(|r|r["tools"].as_u64().unwrap()).sum::<u64>() as f64 / requests.len().max(1) as f64});
    for key in ["input", "cached", "uncached", "output", "usd", "usd_cold"] {
        row[key] = json!(
            requests
                .iter()
                .map(|r| r[key].as_f64().unwrap())
                .sum::<f64>()
        );
    }
    if !super::blind(set) {
        row["largest_tool_outputs"] = json!(largest);
    }
    row["requests"] = json!(requests);
    row
}
fn tool_names(policy: &Policy) -> HashMap<(String, String), Value> {
    let mut names = HashMap::new();
    for exchange in &policy.exchanges {
        for item in &exchange.items {
            if let Some(id) = item["call_id"].as_str() {
                let args: Value = serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))
                    .unwrap_or(Value::Null);
                let name = if item["name"] == "tool_call" {
                    args["id"].clone()
                } else {
                    item["name"].clone()
                };
                names.insert((exchange.lane.clone(), id.to_owned()), name);
            }
        }
    }
    names
}
fn pricing() -> Value {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../../butler-models/src/models/catalog/static-catalog.json"
    ))
    .unwrap();
    catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model_ref"] == "openai/gpt-6.1-sol")
        .unwrap()["pricing"]
        .clone()
}
fn price(pricing: &Value, input: usize, cached: usize, output: usize) -> (f64, f64) {
    let tier = pricing["prompt_tiers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| input as u64 > t["above_input_tokens"].as_u64().unwrap())
        .max_by_key(|t| t["above_input_tokens"].as_u64().unwrap());
    let rate = |key: &str| {
        tier.and_then(|t| t[key].as_f64())
            .or(pricing[key].as_f64())
            .unwrap()
            / 1e6
    };
    let outgoing = output as f64 * rate("output_per_mtok_usd");
    (
        (input - cached) as f64 * rate("input_per_mtok_usd")
            + cached as f64 * rate("cached_input_per_mtok_usd")
            + outgoing,
        input as f64 * rate("input_per_mtok_usd") + outgoing,
    )
}
fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        values[mid - 1].midpoint(values[mid])
    } else {
        values[mid]
    })
}
pub(super) fn redact(row: &mut Value, set: &str, index: usize) {
    row["id"] = json!(format!("{set}/{index}"));
    if row["status"] == "incomplete" {
        *row = json!({"id":format!("{set}/{index}"),"set":set,"status":"incomplete"});
        return;
    }
    let fields = row.as_object_mut().unwrap();
    for key in [
        "shape",
        "missed",
        "runtime_models",
        "requests",
        "largest_tool_outputs",
        "unreadable",
        "last_lane_state",
        "terminal",
        "error",
    ] {
        fields.remove(key);
    }
}
pub(super) fn summary(rows: &[Value]) -> Value {
    let mut sets = BTreeMap::<&str, Vec<f64>>::new();
    for row in rows {
        let costs = sets.entry(row["set"].as_str().unwrap()).or_default();
        if let Some(usd) = row["usd"].as_f64() {
            costs.push(usd);
        }
    }
    let per_set: BTreeMap<_, _> = sets
        .into_iter()
        .map(|(set, costs)| (set, median(costs)))
        .collect();
    json!({"median_usd":median(rows.iter().filter_map(|r|r["usd"].as_f64()).collect()),
        "median_blind_usd":median(rows.iter().filter(|r|super::blind(r["set"].as_str().unwrap())).filter_map(|r|r["usd"].as_f64()).collect()),
        "median_usd_per_set":per_set,
        "completed_tasks":rows.iter().filter(|r|r["status"] != "incomplete").count(),
        "incomplete_tasks":rows.iter().filter(|r|r["status"] == "incomplete").count(),
        "priced_tasks":rows.iter().filter(|r|r["usd"].is_number()).count(),
        "all_facts_kept":rows.iter().all(|r|r["status"] != "incomplete" && r["facts_found"] == r["facts_total"])})
}

pub(super) fn outcome(row: &mut Value, state: &Value, terminal: &Value, error: Option<&str>) {
    row["status"] = json!(if error.is_none() {
        "complete"
    } else {
        "incomplete"
    });
    row["completed"] = json!(error.is_none());
    row["last_lane_state"] = state.clone();
    row["terminal"] = terminal.clone();
    if let Some(error) = error {
        row["error"] = json!(error);
    }
}
pub(super) fn require_complete(rows: &[Value]) -> Result<(), HarnessError> {
    let count = rows.iter().filter(|r| r["status"] == "incomplete").count();
    if count == 0 {
        Ok(())
    } else {
        Err(HarnessError(format!(
            "{count} research tasks incomplete; reports written"
        )))
    }
}
pub(super) async fn write(
    rows: &[Value],
    out: &std::path::Path,
    print: bool,
) -> Result<(), HarnessError> {
    let markdown = markdown(rows);
    let output = json!({"pricing_model":"openai/gpt-6.1-sol","tasks":rows,"summary":summary(rows)});
    let out = out.to_owned();
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        std::fs::create_dir_all(&out)?;
        for (name, bytes) in [
            ("report.json", serde_json::to_vec_pretty(&output)?),
            ("report.md", markdown.as_bytes().to_vec()),
        ] {
            let temporary = out.join(format!("{name}.tmp"));
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(temporary, out.join(name))?;
        }
        if print {
            eprintln!("{markdown}");
        }
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}
