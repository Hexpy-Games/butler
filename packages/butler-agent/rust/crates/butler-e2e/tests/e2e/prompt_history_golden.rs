//! Every-turn parity projections. Normalization is restricted to time, temporary
//! sandbox paths and the live configuration hash. No identity/content stripping.
use super::*;
use sha2::{Digest, Sha256};

pub(super) fn capture(
    data: &std::path::Path,
    requests: &[Value],
    placeholders: &butler_e2e::e2e::sanitize::Placeholders,
) -> Result<Value, HarnessError> {
    let request = &requests[0];
    let text = source(request);
    let blocks = blocks(text, placeholders);
    let instructions = normalize(request["instructions"].as_str().unwrap(), placeholders);
    let history = text
        .lines()
        .filter(|s| s.starts_with("user: ") || s.starts_with("butler: "))
        .collect::<Vec<_>>();
    Ok(
        json!({"sections":loaded_sections(data,request,placeholders)?,"blocks":blocks,
        "instructions_sha256":format!("{:x}",Sha256::digest(instructions)),
        "tools_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&request["tools"])?)),
        "history":history,"wire_bytes":requests.iter().map(|r|serde_json::to_vec(r).unwrap().len()).sum::<usize>()}),
    )
}

fn normalize(text: &str, paths: &butler_e2e::e2e::sanitize::Placeholders) -> String {
    paths
        .hide(text)
        .lines()
        .map(|line| {
            for field in [
                "Current Time UTC:",
                "Current Local Time:",
                "Live Configuration Hash:",
            ] {
                if line.starts_with(field) {
                    return format!("{field} {{{{PER_RUN}}}}");
                }
            }
            line.to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn blocks(text: &str, paths: &butler_e2e::e2e::sanitize::Placeholders) -> Value {
    let mut result = serde_json::Map::new();
    for (id, marker) in [
        ("scope", "Current scope:"),
        ("work", "## Current Work"),
        ("work-stream", "## Active Work State"),
        ("effects", "## Persistent effect facts for current Work"),
        ("attachments", "## User attachments"),
        (
            "project-sources",
            "Explicit user-selected project source snapshots.",
        ),
        ("prior-tools", "## Previously recorded tool calls for this turn"),
    ] {
        let block = text
            .find(marker)
            .map(|start| {
                let tail = &text[start..];
                let end = tail.find("\n\n").unwrap_or(tail.len());
                normalize(&tail[..end], paths)
            })
            .unwrap_or_default();
        result.insert(id.into(), block.into());
    }
    let current = ["## Current request\n","## Delegated result\nSteward:\n","## Delegated result\nWorker:\n","User request:\n"].iter()
        .find_map(|marker|text.split_once(marker).map(|(_,tail)|tail.split("\n\nCurrent scope:").next().unwrap().trim().to_owned())).unwrap_or_default();
    result.insert("current-request".into(), normalize(&current, paths).into());
    result.into()
}

pub(super) fn compare(case: &str, requests: &[Value]) -> Result<(), HarnessError> {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/prompt-history");
    let main: Vec<Value> =
        serde_json::from_slice(&std::fs::read(directory.join(format!("{case}.json")))?)?;
    assert_eq!(
        main.len(),
        requests.len(),
        "{case}: every turn must be covered"
    );
    for (index, (main, branch)) in main.iter().zip(requests).enumerate() {
        eprintln!(
            "PROMPT_PARITY case={case} turn={index} main_bytes={} branch_bytes={}",
            main["wire_bytes"], branch["wire_bytes"]
        );
        for field in ["sections", "blocks", "instructions_sha256", "tools_sha256"] {
            assert_eq!(
                main[field], branch[field],
                "{case} turn={index} section={field}"
            );
        }
        for line in branch["history"].as_array().unwrap() {
            assert!(
                main["history"].as_array().unwrap().contains(line),
                "{case} turn={index} history={line}"
            );
        }
    }
    Ok(())
}
