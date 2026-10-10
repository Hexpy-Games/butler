use butler_e2e::e2e::{
    cassette::{self, Chunk, Exchange, Meta, RequestRecord, ResponseRecord},
    matching,
    sanitize::{Placeholders, sanitize_body},
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

// Imports an explicitly authorized isolated Luna recording; never calls a provider.
// Usage: import-browser <recording> <cassette> <sha> <recorded-at> <scenario> <host-fixture>
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 7 {
        return Err("expected six recording arguments".into());
    }
    let source = PathBuf::from(&args[1]);
    let destination = PathBuf::from(&args[2]);
    let mut placeholders = Placeholders::default();
    learn_opaque_ids(&source, &mut placeholders)?;
    let mut exchanges = Vec::new();
    for n in 1.. {
        let request = source.join(format!("request-{n}.json"));
        if !request.exists() {
            break;
        }
        let body = fs::read_to_string(request)?;
        learn(&mut placeholders, &body)?;
        let value: Value = serde_json::from_str(&body)?;
        assert_eq!(value["model"], "gpt-6-luna");
        let key = matching::key("/codex/responses", &value, &placeholders);
        let raw = fs::read_to_string(source.join(format!("response-{n}.sse")))?;
        let sanitized = sanitize_body(&placeholders.hide(&coalesce_deltas(&raw)?), &placeholders);
        let chunks = sanitized
            .split_inclusive("\n\n")
            .map(|text| Chunk {
                delay_ms: 0,
                text: text.to_owned(),
            })
            .collect();
        exchanges.push(Exchange {
            request: RequestRecord {
                method: "POST".into(),
                path: "/codex/responses".into(),
                key,
            },
            response: ResponseRecord {
                status: 200,
                headers: vec![("content-type".into(), "text/event-stream".into())],
                chunks,
            },
        });
    }
    if exchanges.is_empty() {
        return Err("no Luna exchanges found".into());
    }
    let meta = Meta { scenario: args[5].clone(), provider: "openai-subscription".into(),
        model: "openai/gpt-6-luna".into(), effort: exchanges[0].request.key.effort.clone(), wire_shape: "openai_responses".into(),
        butler_git_sha: args[3].clone(), recorded_at: args[4].clone(), recorder: "isolated Electron live proxy; butler-e2e browser_import".into(),
        sanitization: vec!["Existing butler-e2e sanitizer; request echoes and credentials removed; work echo IDs normalized; request keys only".into()],
        ..Meta::default() };
    cassette::write(&destination, meta, &exchanges)?;
    let calls = import_host(&source, &PathBuf::from(&args[6]), &placeholders)?;
    println!(
        "Imported {} Luna exchanges and {calls} native host results",
        exchanges.len()
    );
    Ok(())
}

fn import_host(
    source: &Path,
    destination: &Path,
    placeholders: &Placeholders,
) -> Result<usize, Box<dyn std::error::Error>> {
    let host: Vec<Value> = (1..)
        .map_while(|n| fs::read(source.join(format!("host-{n}.json"))).ok())
        .map(|bytes| serde_json::from_slice(&bytes))
        .collect::<Result<_, _>>()?;
    let calls: Vec<Value> = host
        .into_iter()
        .filter(|v| v.get("result").is_some())
        .map(|mut value| {
            let frame = &mut value["frame"];
            frame
                .as_object_mut()
                .ok_or("host frame must be an object")?
                .retain(|key, _| matches!(key.as_str(), "op" | "tab" | "args"));
            frame["args"]
                .as_object_mut()
                .map(|args| args.remove("policy"));
            Ok::<_, Box<dyn std::error::Error>>(value)
        })
        .collect::<Result<_, _>>()?;
    fs::write(
        destination,
        sanitize_body(
            &placeholders.hide(&serde_json::to_string(&calls)?),
            placeholders,
        ),
    )?;
    Ok(calls.len())
}

fn learn_opaque_ids(
    source: &Path,
    placeholders: &mut Placeholders,
) -> Result<(), Box<dyn std::error::Error>> {
    let uuid =
        regex::Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")?;
    for prefix in ["request-", "response-", "host-"] {
        for n in 1.. {
            let suffix = if prefix == "response-" { "sse" } else { "json" };
            let path = source.join(format!("{prefix}{n}.{suffix}"));
            if !path.exists() {
                break;
            }
            for found in uuid.find_iter(&fs::read_to_string(path)?) {
                if !placeholders
                    .0
                    .iter()
                    .any(|(_, value)| value == found.as_str())
                {
                    let name = format!("BROWSER_OPAQUE_{}", placeholders.0.len());
                    placeholders.add(&name, found.as_str());
                }
            }
        }
    }
    Ok(())
}

fn learn(placeholders: &mut Placeholders, request: &str) -> Result<(), regex::Error> {
    for (pattern, prefix) in [
        ("guided-work-[0-9a-f]{64}", "ECHO_"),
        ("guided-plan-[0-9a-f]{64}", "PLAN_ECHO_"),
        ("memory-detail:v1:[0-9a-f]{64}", "DETAIL_ECHO_"),
        (
            r"\bmessage-(?:stream-turn-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            "MSG_ECHO_",
        ),
        (
            r"artifacts/public-data/browser-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg",
            "BROWSER_IMAGE_ECHO_",
        ),
    ] {
        for found in regex::Regex::new(pattern)?.find_iter(request) {
            if placeholders
                .0
                .iter()
                .any(|(_, value)| value == found.as_str())
            {
                continue;
            }
            let next = placeholders
                .0
                .iter()
                .filter(|(name, _)| name.starts_with(prefix))
                .count()
                + 1;
            placeholders.add(&format!("{prefix}{next}"), found.as_str());
        }
    }
    Ok(())
}

// Preserve the complete original text, while allowing volatile IDs split at
// token boundaries to be normalized consistently with output_item.done.
fn coalesce_deltas(raw: &str) -> Result<String, serde_json::Error> {
    let mut events: Vec<Value> = raw
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    let mut first = std::collections::HashMap::new();
    for index in 0..events.len() {
        let kind = events[index]["type"].as_str().unwrap_or("");
        if !matches!(
            kind,
            "response.output_text.delta" | "response.function_call_arguments.delta"
        ) {
            continue;
        }
        let key = (
            kind.to_owned(),
            events[index]["item_id"].as_str().unwrap_or("").to_owned(),
        );
        if let Some(&prior) = first.get(&key) {
            let delta = events[index]["delta"].as_str().unwrap_or("").to_owned();
            let value: &mut Value = &mut events[prior];
            value["delta"] = Value::String(format!(
                "{}{}",
                value["delta"].as_str().unwrap_or(""),
                delta
            ));
            events[index]["delta"] = Value::String(String::new());
        } else {
            first.insert(key, index);
        }
    }
    let mut text = String::new();
    for event in events {
        text.push_str("data: ");
        text.push_str(&event.to_string());
        text.push_str("\n\n");
    }
    Ok(text)
}
