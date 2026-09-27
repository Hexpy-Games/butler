use serde_json::Value;

use super::contracts::{EffectFailure, EffectResult, RecoveryEntry};

pub(crate) fn normalize_entries(value: &Value) -> EffectResult<Vec<RecoveryEntry>> {
    let rows = value
        .as_array()
        .filter(|rows| (2..=20).contains(&rows.len()))
        .ok_or_else(|| invalid("Guided edit batch recovery entries must contain 2-20 entries"))?;
    let mut files = std::collections::HashMap::new();
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let record = row.as_object().ok_or_else(|| {
                invalid(format!(
                    "Guided edit batch recovery entry {index} is invalid"
                ))
            })?;
            if record.len() != 4
                || !["afterSha256", "beforeSha256", "path", "startLine"]
                    .iter()
                    .all(|key| record.contains_key(*key))
            {
                return Err(invalid(format!(
                    "Guided edit batch recovery entry {index} has unknown fields"
                )));
            }
            let path = record.get("path").and_then(Value::as_str).ok_or_else(|| {
                invalid(format!(
                    "Guided edit batch recovery entry {index} has an invalid path"
                ))
            })?;
            let normalized = normalize_path(path).ok_or_else(|| {
                invalid(format!(
                    "Guided edit batch recovery entry {index} has an invalid path"
                ))
            })?;
            let start_line = record
                .get("startLine")
                .and_then(Value::as_i64)
                .filter(|value| (1..=9_007_199_254_740_991).contains(value))
                .ok_or_else(|| {
                    invalid(format!(
                        "Guided edit batch recovery entry {index} has an invalid start line"
                    ))
                })?;
            let before_sha256 = sha(record.get("beforeSha256"), index, "beforeSha256")?;
            let after_sha256 = sha(record.get("afterSha256"), index, "afterSha256")?;
            if let Some((before, after)) = files.get(&normalized)
                && (before != &before_sha256 || after != &after_sha256)
            {
                return Err(invalid(format!(
                    "Guided edit batch recovery entry {index} has inconsistent file hashes"
                )));
            }
            files.insert(
                normalized.clone(),
                (before_sha256.clone(), after_sha256.clone()),
            );
            Ok(RecoveryEntry {
                path: normalized,
                start_line,
                before_sha256,
                after_sha256,
            })
        })
        .collect()
}
fn invalid(message: impl Into<String>) -> EffectFailure {
    EffectFailure::policy("effect_recovery_invalid", message)
}
fn sha(value: Option<&Value>, index: usize, field: &str) -> EffectResult<String> {
    let text = value
        .and_then(Value::as_str)
        .filter(|text| text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            invalid(format!(
                "Guided edit batch recovery entry {index} has an invalid {field}"
            ))
        })?;
    Ok(text.to_ascii_lowercase())
}
fn normalize_path(value: &str) -> Option<String> {
    if value.is_empty()
        || value.encode_utf16().count() > 512
        || crate::public_text::trim_js_whitespace(value) != value
        || value.contains('\0')
        || value.starts_with('/')
        || value.starts_with('\\')
        || value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && value.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    let slash = value.replace('\\', "/");
    if slash.starts_with('/')
        || slash
            .split('/')
            .any(|part| part.is_empty() || part == "." || (part == ".." && slash != ".."))
    {
        return None;
    }
    Some(slash)
}
