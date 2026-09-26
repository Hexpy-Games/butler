use std::collections::HashMap;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::contracts::{CanonicalProfileSourceFactory, ProfileResult, ProfilingMode};
use super::super::{projection, storage};
use super::types::{CorrectionTarget, CorrectionTargets};

pub(super) fn read(
    root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    mode: ProfilingMode,
    salt: &str,
    now_ms: i64,
) -> ProfileResult<CorrectionTargets> {
    let entries = projection::correction_entries(root, sources, mode, now_ms)?;
    let mut public = Vec::new();
    let mut private = HashMap::new();
    for (index, entry) in entries.into_iter().take(4).enumerate() {
        let entry_revision = revision(&entry);
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("{salt}\0{}", entry.id).as_bytes())
        );
        let reference = format!("profile_target:{}:{index}", &digest[..16]);
        let conditions = normalized_conditions(strings(&entry.payload, "applies_when"));
        let facet = entry
            .payload
            .get("facet")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let instruction = strings(&entry.payload, "butler_should")
            .into_iter()
            .next()
            .or_else(|| {
                entry
                    .payload
                    .get("summary")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        public.push(json!({"target_ref":reference,"instruction":instruction,"category":entry.category,"facet":facet,"applies_when":conditions}));
        private.insert(
            reference,
            CorrectionTarget {
                stable_id: entry.id,
                category: entry.category,
                facet,
                applies_when: conditions,
                revision: entry_revision,
            },
        );
    }
    Ok(CorrectionTargets { public, private })
}

pub(super) fn revision(entry: &storage::StoredEntry) -> String {
    let object = json!({
        "id":entry.id,
        "category":entry.category,
        "facet":entry.payload.get("facet").cloned().unwrap_or(Value::Null),
        "summary":entry.payload.get("summary").cloned().unwrap_or(Value::String(String::new())),
        "applies_when":normalized_conditions(strings(&entry.payload,"applies_when")),
        "butler_should":entry.payload.get("butler_should").cloned().unwrap_or(Value::Array(Vec::new())),
        "butler_should_not":entry.payload.get("butler_should_not").cloned().unwrap_or(Value::Array(Vec::new())),
        "evidence_refs":entry.payload.get("evidence_refs").cloned().unwrap_or(Value::Array(Vec::new())),
        "evidence_observed_at":entry.payload.get("evidence_observed_at").cloned().unwrap_or(Value::Object(Default::default())),
        "updated_at":entry.updated_at,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_string(&object).unwrap().as_bytes())
    )
}

pub(super) fn normalized_conditions(mut values: Vec<String>) -> Vec<String> {
    values = values
        .into_iter()
        .map(|value| crate::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty())
        .collect();
    values.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    values.dedup();
    values
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
