//! Source selectors for registered command, grep, and conversation results.

use std::collections::HashSet;

use crate::btcc::BtccError;
use crate::json::{raw_string_units, visit_raw_array, visit_raw_object};

use super::{append_field, failure, field};

pub(super) fn project(name: &str, raw: &str) -> Result<String, BtccError> {
    let excluded: &[&str] = match name {
        "run_command" => &["evidence_receipts", "evidence_capability_receipts"],
        "grep_files" => &[
            "evidence_receipts",
            "evidence_capability_receipts",
            "metrics",
        ],
        "read_conversation_context" => &["runtime_session_id"],
        _ => &[],
    };
    let mut result = String::from("{\"tool_name\":");
    if let Some(raw_name) = field(raw, "tool_name")? {
        result.push_str(raw_name);
    } else {
        crate::json::write_string(name, &mut result).map_err(|_| failure())?;
    }
    visit_raw_object(raw, |key, value| {
        let decoded = serde_json::from_str::<String>(key).map_err(crate::json::JsonError::from)?;
        if !excluded.contains(&decoded.as_str()) && decoded != "tool_name" {
            result.push(',');
            result.push_str(key);
            result.push(':');
            result.push_str(value);
        }
        Ok(())
    })
    .map_err(|_| failure())?;
    if name == "grep_files" {
        let mut paths = String::from("[");
        let mut seen = HashSet::new();
        let mut count = 0usize;
        if let Some(matches) = field(raw, "matches")?.filter(|raw| raw.trim().starts_with('[')) {
            visit_raw_array(matches, |item| {
                count += 1;
                if let Some(path) = field(item, "path")
                    .map_err(crate::json::JsonError::callback)?
                    .filter(|raw| raw.trim_start().starts_with('"'))
                {
                    let units = raw_string_units(path).collect::<Vec<_>>();
                    if seen.insert(units) {
                        if paths.len() > 1 {
                            paths.push(',');
                        }
                        paths.push_str(path);
                    }
                }
                Ok(())
            })
            .map_err(|_| failure())?;
        }
        paths.push(']');
        append_field(&mut result, "match_count", &count.to_string())?;
        append_field(&mut result, "candidate_paths", &paths)?;
    }
    result.push('}');
    Ok(result)
}
