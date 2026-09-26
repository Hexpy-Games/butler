//! Borrowed JSON inspection of registered command stdout metadata.

use indexmap::IndexSet;
use serde_json::value::RawValue;

use crate::json::{raw_string_units, visit_raw_array, visit_raw_object};

const PATH_KEYS: &[&str] = &[
    "artifact_file",
    "artifact_path",
    "file_path",
    "output_path",
    "report_path",
    "written_file",
];
const ARRAY_KEYS: &[&str] = &[
    "artifact_files",
    "artifact_paths",
    "file_paths",
    "output_paths",
    "report_paths",
    "verified_output_files",
    "written_files",
];

pub(super) struct Validation {
    pub suite: Vec<u16>,
    pub result: &'static str,
    pub failure_summary: Option<Vec<u16>>,
}

pub(super) struct Metadata {
    pub paths: Vec<String>,
    pub validations: Vec<Validation>,
}

fn string(raw: &str) -> Option<String> {
    if !raw.starts_with('"') {
        return None;
    }
    Some(String::from_utf16_lossy(
        &raw_string_units(raw).collect::<Vec<_>>(),
    ))
}

fn trim_string(raw: &str) -> Option<String> {
    let value = string(raw)?;
    let trimmed = crate::public_text::trim_js_whitespace(&value);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn is_space(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a |
        0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// JavaScript /\s+/gu, trim, then slice by UTF-16 units. The returned value
/// can end on an unpaired surrogate and must enter an encoded JSON receipt.
fn normalized(raw: &str, limit: usize) -> Option<Vec<u16>> {
    if !raw.starts_with('"') {
        return None;
    }
    let mut output = Vec::with_capacity(limit);
    let mut pending_space = false;
    for unit in raw_string_units(raw) {
        if is_space(unit) {
            pending_space = !output.is_empty();
            continue;
        }
        if pending_space && output.len() < limit {
            output.push(0x20);
        }
        pending_space = false;
        if output.len() < limit {
            output.push(unit);
        }
        if output.len() >= limit {
            break;
        }
    }
    (!output.is_empty()).then_some(output)
}

fn result(raw: &str) -> Option<&'static str> {
    match string(raw)?.as_str() {
        "passed" | "pass" | "success" => Some("passed"),
        "failed" | "fail" | "failure" => Some("failed"),
        "partial" | "incomplete" => Some("partial"),
        "skipped" | "skip" => Some("skipped"),
        _ => None,
    }
}

fn parse_validation(raw: &str) -> Option<Validation> {
    if !raw.starts_with('{') {
        return None;
    }
    let (mut suite, mut status, mut failure, mut camel) = (None, None, None, None);
    visit_raw_object(raw, |key, value| {
        let key = string(key).unwrap_or_default();
        match key.as_str() {
            "suite" => suite = Some(value),
            "result" => status = Some(value),
            "failure_summary" => failure = Some(value),
            "failureSummary" => camel = Some(value),
            _ => {}
        }
        Ok(())
    })
    .ok()?;
    Some(Validation {
        suite: normalized(suite?, 120)?,
        result: result(status?)?,
        failure_summary: if failure.is_some_and(|raw| raw.starts_with('"')) {
            failure.and_then(|raw| normalized(raw, 180))
        } else {
            camel.and_then(|raw| normalized(raw, 180))
        },
    })
}

fn collect_validations(raw: &str, out: &mut Vec<Validation>) {
    if out.len() >= 8 {
        return;
    }
    if raw.starts_with('[') {
        let _ = visit_raw_array(raw, |item| {
            collect_validations(item, out);
            Ok(())
        });
        return;
    }
    if !raw.starts_with('{') {
        return;
    }
    let (mut one, mut two, mut many) = (None, None, None);
    let _ = visit_raw_object(raw, |key, value| {
        match string(key).as_deref() {
            Some("validation_result") => one = Some(value),
            Some("validation") => two = Some(value),
            Some("validation_results") => many = Some(value),
            _ => {}
        }
        Ok(())
    });
    for raw in [one, two].into_iter().flatten() {
        if let Some(value) = parse_validation(raw) {
            out.push(value);
        }
        if out.len() >= 8 {
            return;
        }
    }
    if let Some(raw) = many.filter(|raw| raw.starts_with('[')) {
        let _ = visit_raw_array(raw, |item| {
            if out.len() < 8
                && let Some(value) = parse_validation(item)
            {
                out.push(value);
            }
            Ok(())
        });
    }
}

fn collect_paths(raw: &str, out: &mut IndexSet<String>) {
    if out.len() >= 24 {
        return;
    }
    if raw.starts_with('[') {
        let _ = visit_raw_array(raw, |item| {
            collect_paths(item, out);
            Ok(())
        });
        return;
    }
    if !raw.starts_with('{') {
        return;
    }
    let _ = visit_raw_object(raw, |key, value| {
        if out.len() >= 24 {
            return Ok(());
        }
        let key = string(key).unwrap_or_default();
        if PATH_KEYS.contains(&key.as_str()) {
            if let Some(path) = trim_string(value) {
                out.insert(path);
            }
        } else if ARRAY_KEYS.contains(&key.as_str()) && value.starts_with('[') {
            let _ = visit_raw_array(value, |child| {
                if out.len() >= 24 {
                    return Ok(());
                }
                if let Some(path) = trim_string(child) {
                    out.insert(path);
                }
                Ok(())
            });
            let _ = visit_raw_array(value, |child| {
                if out.len() >= 24 {
                    return Ok(());
                }
                if child.starts_with('{') {
                    let _ = visit_raw_object(child, |name, item| {
                        if string(name).as_deref() == Some("path")
                            && let Some(path) = trim_string(item)
                        {
                            out.insert(path);
                        }
                        Ok(())
                    });
                }
                Ok(())
            });
        }
        Ok(())
    });
}

pub(super) fn inspect(stdout: &str) -> Metadata {
    let mut paths = IndexSet::new();
    let mut validations = Vec::new();
    let trimmed = crate::public_text::trim_js_whitespace(stdout);
    if trimmed.is_empty() {
        return Metadata {
            paths: Vec::new(),
            validations,
        };
    }
    let mut inspect_one = |candidate: &str| {
        if serde_json::from_str::<&RawValue>(candidate).is_ok() {
            collect_paths(candidate, &mut paths);
            collect_validations(candidate, &mut validations);
        }
    };
    inspect_one(trimmed);
    for line in trimmed.split("\n") {
        let candidate = crate::public_text::trim_js_whitespace(line.trim_end_matches('\r'));
        if candidate.is_empty()
            || candidate == trimmed
            || !(candidate.starts_with('{') || candidate.starts_with('['))
        {
            continue;
        }
        inspect_one(candidate);
    }
    Metadata {
        paths: paths.into_iter().collect(),
        validations: validations.into_iter().take(8).collect(),
    }
}

pub(super) fn append_declared_validation(
    metadata: &mut Metadata,
    args: &serde_json::Map<String, serde_json::Value>,
    exit_code: Option<i32>,
    timed_out: bool,
) {
    if metadata.validations.len() >= 8 {
        return;
    }
    let Some(suite) = args
        .get("validation_suite")
        .and_then(serde_json::Value::as_str)
    else {
        return;
    };
    let suite = crate::public_text::trim_js_whitespace(suite);
    if suite.is_empty()
        || metadata
            .validations
            .iter()
            .any(|value| value.suite.iter().copied().eq(suite.encode_utf16()))
    {
        return;
    }
    let passed = exit_code == Some(0) && !timed_out;
    let failure = if passed {
        None
    } else if timed_out {
        Some("Validation command timed out.".to_owned())
    } else {
        Some(format!(
            "Validation command exited with status {}.",
            exit_code.map_or_else(|| "unknown".into(), |code| code.to_string())
        ))
    };
    metadata.validations.push(Validation {
        suite: suite.encode_utf16().collect(),
        result: if passed { "passed" } else { "failed" },
        failure_summary: failure.map(|text| text.encode_utf16().collect()),
    });
}
