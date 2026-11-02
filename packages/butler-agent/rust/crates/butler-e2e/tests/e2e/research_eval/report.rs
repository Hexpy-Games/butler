use super::{
    fixture::Task,
    policy::{Policy, normalized, output_text},
};
use butler_e2e::e2e::HarnessError;
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
    Ok(task_row(task, set, answer, &calls, &requests, &largest))
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
        "average_tools_tokens":requests.iter().map(|r|r["tools"].as_u64().unwrap()).sum::<u64>() as f64 / requests.len() as f64});
    for key in ["input", "cached", "uncached", "output", "usd", "usd_cold"] {
        row[key] = json!(
            requests
                .iter()
                .map(|r| r[key].as_f64().unwrap())
                .sum::<f64>()
        );
    }
    if set == "tasks" {
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
pub(super) fn summary(rows: &[Value]) -> Value {
    json!({"median_usd":median(rows.iter().map(|r|r["usd"].as_f64().unwrap()).collect()),
        "median_holdout_usd":median(rows.iter().filter(|r|r["set"] == "holdout").map(|r|r["usd"].as_f64().unwrap()).collect()),
        "all_facts_kept":rows.iter().all(|r|r["facts_found"] == r["facts_total"])})
}
pub(super) fn markdown(rows: &[Value]) -> String {
    use std::fmt::Write;
    let mut text = "| Task | Shape | Facts | Calls | Input | Cached | Uncached | Output | Avg tools | USD | Cold USD |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n".to_owned();
    let mut holdout = 0;
    for row in rows {
        let id = if row["set"] == "holdout" {
            holdout += 1;
            format!("holdout/{holdout}")
        } else {
            row["id"].as_str().unwrap().replace('|', "\\|")
        };
        writeln!(
            text,
            "| {} | {} | {}/{} | {} | {:.0} | {:.0} | {:.0} | {:.0} | {:.0} | {:.6} | {:.6} |",
            id,
            if row["set"] == "holdout" {
                "—"
            } else {
                row["shape"].as_str().unwrap()
            },
            row["facts_found"],
            row["facts_total"],
            row["calls"],
            row["input"].as_f64().unwrap(),
            row["cached"].as_f64().unwrap(),
            row["uncached"].as_f64().unwrap(),
            row["output"].as_f64().unwrap(),
            row["average_tools_tokens"].as_f64().unwrap(),
            row["usd"].as_f64().unwrap(),
            row["usd_cold"].as_f64().unwrap()
        )
        .unwrap();
    }
    let summary = summary(rows);
    writeln!(text, "\nMedian USD: {}. Holdout median USD: {}. All facts kept: {}.\n\nToken estimates: o200k over serialized instructions, tools, input and reply items. Cached tokens are the common token prefix with the previous request in that lane. Prices are estimates from the static catalog, including per-request prompt tiers.",
        summary["median_usd"], summary["median_holdout_usd"], if summary["all_facts_kept"] == true { "yes" } else { "no" }).unwrap();
    text
}
