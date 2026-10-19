//! Provider-prefix and journal oracles for browser batch pruning.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use butler_e2e::e2e::HarnessError;
use serde_json::Value;

pub(crate) fn diagnostics(data: &std::path::Path) -> Result<Vec<Value>, HarnessError> {
    let text = std::fs::read_to_string(data.join("metrics/request-prefix-diagnostics.jsonl"))?;
    Ok(text
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?
        .into_iter()
        .filter(|r| r["requestStarted"] == true && r["sessionKind"] == "parent")
        .collect())
}

pub(crate) fn outputs(request: &Value) -> Vec<(Value, bool)> {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| {
            let parts = item["output"].as_array();
            let text = parts
                .and_then(|p| p.iter().find(|p| p["type"] == "input_text"))
                .map(|p| &p["text"])
                .unwrap_or(&item["output"])
                .as_str()?;
            let value: Value = serde_json::from_str(text).ok()?;
            let image = parts.is_some_and(|p| p.iter().any(|p| p["type"] == "input_image"));
            (value["output"]["schema"] == "butler.browser-observation.v1").then_some((value, image))
        })
        .collect()
}

pub(crate) fn assert_prefix(requests: &[Value], rows: &[Value]) {
    for request in requests {
        if let Some((newest, image)) = outputs(request).last() {
            assert!(
                newest["output"]["untrusted_content"]["text"]
                    .as_str()
                    .unwrap()
                    .starts_with("link \"Page ")
            );
            assert!(*image, "newest observation retains pixels");
        }
    }
    assert_prunes(requests, rows);
}

pub(crate) fn assert_prunes(requests: &[Value], rows: &[Value]) {
    assert_eq!(requests.len(), rows.len());
    let mut watermark = 0;
    let mut previous_prune = false;
    let mut prunes = 0;
    for (index, (request, row)) in requests.iter().zip(rows).enumerate() {
        let observations = outputs(request);
        for (position, (value, _)) in observations.iter().enumerate() {
            if value["output"]["status"] == "superseded" {
                assert!(
                    observations[position + 1..].iter().any(
                        |(later, _)| later["output"]["obs"] == value["output"]["superseded_by"]
                    )
                );
            }
        }
        let prune = index > 0 && row["appendOnly"] == false;
        if index > 0 {
            assert_changes(&requests[index - 1], request, prune);
        }
        if prune {
            assert!(
                !previous_prune,
                "consecutive prune requests at round {index}"
            );
            assert_eq!(row["firstDifference"]["component"], "input");
            let normal = usize::try_from(row["firstDifference"]["index"].as_u64().unwrap())
                .unwrap()
                >= watermark;
            let deep = observations
                .iter()
                .filter(|(v, _)| v["output"]["status"] != "superseded")
                .count()
                == 1;
            assert!(
                normal || deep,
                "prune rewrites frozen full history at round {index}"
            );
            watermark = request["input"].as_array().unwrap().len();
            prunes += 1;
        } else if index > 0 {
            assert_eq!(
                row["appendOnly"], true,
                "prefix changed outside prune at {index}"
            );
        }
        previous_prune = prune;
    }
    assert!(prunes > 0, "large stale history must prune");
    eprintln!(
        "BROWSER_PREFIX requests={} append_only={} prunes={} prefixTokens={} lcpTokens={} max_body_bytes={}",
        requests.len(),
        rows.iter()
            .skip(1)
            .filter(|r| r["appendOnly"] == true)
            .count(),
        prunes,
        rows.iter()
            .filter_map(|r| r["prefixTokens"].as_u64())
            .sum::<u64>(),
        rows.iter()
            .filter_map(|r| r["lcpTokens"].as_u64())
            .sum::<u64>(),
        requests.iter().map(|r| r.to_string().len()).max().unwrap()
    );
}

pub(crate) fn assert_journal(
    data: &std::path::Path,
    turn: &str,
    requests: &[Value],
) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    let mut query = db.prepare("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_act' ORDER BY rowid")?;
    let records = query
        .query_map([turn], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(records.len(), 13);
    let mut completed = std::collections::HashMap::new();
    for (index, record) in records.iter().enumerate() {
        let value: Value = serde_json::from_str(record)?;
        let output = value.get("output").unwrap_or(&value);
        assert!(
            output["image"]["data"]
                .as_str()
                .is_some_and(|data| data.len() > 100_000)
        );
        assert!(
            output["untrusted_content"]["text"]
                .as_str()
                .unwrap()
                .starts_with("link \"Page ")
        );
        assert!(output["untrusted_content"]["text"].as_str().unwrap().len() > 6_000);
        let count = output["action"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["status"] == "completed")
            .count();
        completed.insert(format!("o{}", index + 1), count);
    }
    for request in requests {
        assert_receipts(request, &completed);
    }
    Ok(())
}

fn assert_receipts(request: &Value, completed: &std::collections::HashMap<String, usize>) {
    let mut calls = std::collections::HashMap::new();
    let mut receipts: std::collections::HashMap<String, Vec<String>> = Default::default();
    let mut seen = std::collections::HashSet::new();
    for item in request["input"].as_array().unwrap() {
        if item["type"] == "function_call" {
            let args: Value = serde_json::from_str(item["arguments"].as_str().unwrap()).unwrap();
            let (name, args) = if item["name"] == "tool_call" {
                (args["id"].as_str().unwrap(), &args["arguments"])
            } else {
                (item["name"].as_str().unwrap(), &args)
            };
            if matches!(name, "browser_act" | "native:browser_act") {
                calls.insert(item["call_id"].as_str().unwrap(), args.clone());
            }
        }
        let Some(args) = calls.get(item["call_id"].as_str().unwrap_or_default()) else {
            continue;
        };
        if item["type"] != "function_call_output" {
            continue;
        }
        assert!(
            seen.insert(item["call_id"].as_str().unwrap()),
            "one output per act"
        );
        let text = item["output"]
            .as_str()
            .or_else(|| {
                item["output"]
                    .as_array()?
                    .iter()
                    .find(|p| p["type"] == "input_text")?["text"]
                    .as_str()
            })
            .unwrap();
        let value: Value = serde_json::from_str(text).unwrap();
        let output = &value["output"];
        let obs = args["observation"].as_str().unwrap();
        let acted = if output["status"] == "superseded" || output["superseded"] == true {
            assert!(output.get("action").is_none());
            assert!(!output["steps"].is_array());
            assert_eq!(output["receipt"]["obs"], obs);
            output["receipt"]["acted"].as_str().unwrap().to_owned()
        } else {
            assert!(output.get("receipt").is_none());
            let action = output.get("action").unwrap_or(output);
            full_acted(args, action)
        };
        let count: usize = acted
            .split('×')
            .skip(1)
            .map(|p| {
                p.split_whitespace()
                    .next()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()
            })
            .sum();
        assert_eq!(
            count, completed[obs],
            "every journaled step is represented once"
        );
        receipts.entry(obs.into()).or_default().push(acted);
    }
    assert_eq!(seen.len(), calls.len(), "every browser act has one result");
    for (value, _) in outputs(request) {
        let output = &value["output"];
        if output["status"] == "superseded" {
            let acted = receipts
                .get(output["obs"].as_str().unwrap())
                .map(|parts| parts.join("; "))
                .unwrap_or_default();
            assert_eq!(
                output["acted"], acted,
                "observation summary follows message order"
            );
        }
    }
}

fn full_acted(args: &Value, output: &Value) -> String {
    let steps = output["steps"].as_array().unwrap();
    assert_eq!(steps.len(), args["steps"].as_array().unwrap().len());
    assert!(steps.iter().all(|step| step["status"] == "completed"));
    let mut groups: Vec<(String, usize)> = Vec::new();
    for step in args["steps"].as_array().unwrap() {
        let action = step["action"].as_str().unwrap();
        let target = if matches!(action, "press" | "type" | "wait") {
            step["value"]
                .as_str()
                .map(|v| v.chars().take(24).collect::<String>())
        } else {
            step["ref"].as_str().map(str::to_owned)
        };
        let label = format!("{action} {}", target.as_deref().unwrap_or("point"));
        if let Some((_, count)) = groups.last_mut().filter(|(last, _)| *last == label) {
            *count += 1;
        } else {
            groups.push((label, 1));
        }
    }
    groups
        .into_iter()
        .map(|(label, count)| format!("{label} ×{count} completed"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn assert_changes(previous: &Value, current: &Value, prune: bool) {
    let mut rewrites = 0;
    for (old, new) in previous["input"]
        .as_array()
        .unwrap()
        .iter()
        .zip(current["input"].as_array().unwrap())
    {
        if old == new {
            continue;
        }
        rewrites += 1;
        assert!(prune, "no message changes outside prune rounds");
        assert_eq!(
            new["type"], "function_call_output",
            "only tool outputs may be pruned"
        );
        let text = new["output"].as_str().unwrap();
        let value: Value = serde_json::from_str(text).unwrap();
        assert_eq!(value["output"]["status"], "superseded");
        if let Some(old) = old["output"].as_str() {
            let old: Value = serde_json::from_str(old).unwrap();
            assert_ne!(old["output"]["status"], "superseded", "stubs are final");
        }
    }
    assert_eq!(rewrites > 0, prune);
}
