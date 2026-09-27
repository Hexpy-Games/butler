//! Source receipt semantics paired with retained physical cache evidence.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::cognition::graph::CacheReadinessRow;

pub(in crate::cognition::generation) struct CacheEvidence {
    pub static_invalid: usize,
    pub actual_invalid: usize,
    pub actual_invalid_jobs: Vec<String>,
}

pub(in crate::cognition::generation) fn evaluate(
    rows: &[CacheReadinessRow],
    outcomes: &HashMap<String, bool>,
    valid_entries: &HashSet<String>,
    generation: &str,
) -> CacheEvidence {
    let evicted = rows
        .iter()
        .filter_map(|row| row.receipt_json.as_deref())
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
        .flat_map(|receipt| receipt["entries"].as_array().cloned().unwrap_or_default())
        .flat_map(|entry| {
            entry["excluded_entries"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter(|entry| {
            matches!(
                entry["reason"].as_str(),
                Some("budget" | "oversized" | "expired" | "invalidated")
            )
        })
        .filter_map(|entry| entry["entry_id"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    let mut static_invalid = 0;
    let mut actual_invalid = 0;
    let mut actual_invalid_jobs = Vec::new();
    for row in rows {
        let value = row
            .receipt_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let Some(receipt) = value else {
            static_invalid += 1;
            actual_invalid += 1;
            actual_invalid_jobs.push(row.job_id.clone());
            continue;
        };
        let entries = receipt["entries"].as_array();
        let static_ok = match entries {
            Some(entries) if !entries.is_empty() => entries.iter().all(|entry| {
                entry["generation_id"] == generation && entry["source_revision"] == row.revision
            }),
            None => {
                receipt["outcome"] == "excluded"
                    && receipt["reason"] == "no_summary"
                    && receipt["generation"] == generation
                    && receipt["source_revision"] == row.revision
            }
            _ => false,
        };
        if !static_ok {
            static_invalid += 1;
        }
        let actual_ok = match entries {
            Some(entries) if !entries.is_empty() => entries.iter().all(|entry| {
                let Some(id) = entry["source_id"].as_str() else {
                    return false;
                };
                if entry["generation_id"] != generation || entry["source_revision"] != row.revision
                {
                    return false;
                }
                if outcomes.get(id) == Some(&false)
                    || (outcomes.get(id).is_none()
                        && (entry["admitted"] == false || evicted.contains(id)))
                {
                    return true;
                }
                valid_entries.contains(id)
            }),
            _ => {
                receipt["outcome"] == "excluded"
                    && matches!(
                        receipt["reason"].as_str(),
                        Some("no_summary" | "no_window_summary")
                    )
            }
        };
        if !actual_ok {
            actual_invalid += 1;
            actual_invalid_jobs.push(row.job_id.clone());
        }
    }
    CacheEvidence {
        static_invalid,
        actual_invalid,
        actual_invalid_jobs,
    }
}
