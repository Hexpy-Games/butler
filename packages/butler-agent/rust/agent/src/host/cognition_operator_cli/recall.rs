use std::path::Path;

use serde_json::{Value, json};

use crate::cognition::{CognitionPathEnvironment, LegacyRecallRequest, recall_legacy};

use super::CliError;

pub(super) fn command_name(prefix: &str) -> String {
    format!("butler {prefix} memory recall")
}

pub(super) fn run(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    args: &[String],
) -> Result<(Value, String), CliError> {
    let cue = args
        .iter()
        .skip(3)
        .filter(|argument| !argument.starts_with("--"))
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    if cue.is_empty() {
        return Err(CliError::invalid("memory recall requires <cue>"));
    }
    let response = recall_legacy(
        data_root,
        paths,
        &LegacyRecallRequest {
            cue,
            limit: Some(5.0),
            ..LegacyRecallRequest::default()
        },
    )
    .map_err(|error| CliError::failed(error.code, error.message))?;
    let root = data_root.to_string_lossy();
    let results = response
        .items
        .iter()
        .map(|item| {
            let provenance = item
                .provenance
                .iter()
                .map(|value| {
                    if value.starts_with(root.as_ref()) {
                        Path::new(value)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or(value)
                            .to_owned()
                    } else {
                        value.clone()
                    }
                })
                .collect::<Vec<_>>();
            json!({
                "summary": item.summary.clone(),
                "confidence": item.confidence,
                "source": item.source,
                "provenance": provenance,
            })
        })
        .collect::<Vec<_>>();
    let data = json!({
        "cue": response.cue,
        "seeds": response.seeds,
        "abstained": response.abstained,
        "diagnostics": response.diagnostics,
        "results": results.clone(),
    });
    let human = if results.is_empty() {
        "No high-confidence memory recall results.".to_owned()
    } else {
        results
            .iter()
            .map(|item| {
                format!(
                    "{} {:.1}%: {}",
                    string(item, "source"),
                    item["confidence"].as_f64().unwrap_or_default() * 100.0,
                    string(item, "summary"),
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok((data, human))
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
