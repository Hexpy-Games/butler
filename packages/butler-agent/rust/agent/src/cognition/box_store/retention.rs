use std::{fs, path::Path};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::cognition::CognitionResult;

use super::{error, manifest, paths};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct BoxRetentionReport {
    pub expired_candidate_count: usize,
    pub pruned_box_owned_count: usize,
}

pub(super) fn prune_expired(root: &Path, now_epoch_ms: i64) -> CognitionResult<BoxRetentionReport> {
    let now_iso = crate::js_date::format_iso_millis(now_epoch_ms)
        .ok_or_else(|| error("memory_box_retention_clock_invalid"))?;
    let mut report = BoxRetentionReport::default();
    visit_manifests(root, |item_dir, manifest_path, value| {
        if !is_expired_candidate(&value, now_epoch_ms)? {
            return Ok(());
        }
        report.expired_candidate_count += 1;
        let files = value
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| error("memory_box_manifest_invalid"))?;
        if !all_box_owned(files)? {
            return Ok(());
        }

        let relative_paths = files
            .iter()
            .map(relative_path)
            .collect::<CognitionResult<Vec<_>>>()?;
        let paths = relative_paths
            .into_iter()
            .flatten()
            .map(|relative| paths::validate_relative_file(item_dir, &relative))
            .collect::<CognitionResult<Vec<_>>>()?;
        let manifest_target = paths::validate_manifest_target(manifest_path, item_dir)?;
        let mut forgotten = value;
        mark_forgotten(&mut forgotten, &now_iso)?;
        serde_json::to_vec_pretty(&forgotten)
            .map_err(|_| error("memory_box_manifest_write_failed"))?;
        for path in paths {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(error("memory_box_retention_delete_failed")),
            }
        }
        manifest::write_manifest_value(&manifest_target, &forgotten)?;
        report.pruned_box_owned_count += 1;
        Ok(())
    })?;
    Ok(report)
}

fn visit_manifests(
    root: &Path,
    mut visit: impl FnMut(&Path, &Path, Value) -> CognitionResult<()>,
) -> CognitionResult<()> {
    if paths::canonical_items_root(root)?.is_none() {
        return Ok(());
    }
    let entries =
        fs::read_dir(root.join("items")).map_err(|_| error("memory_box_items_read_failed"))?;
    for entry in entries {
        let entry = entry.map_err(|_| error("memory_box_items_read_failed"))?;
        if !entry
            .file_type()
            .map_err(|_| error("memory_box_items_read_failed"))?
            .is_dir()
        {
            continue;
        }
        let item_dir = entry.path();
        if let Some((manifest, path)) = manifest::read_manifest_value_for_dir(root, &item_dir)? {
            visit(&item_dir, &path, manifest)?;
        }
    }
    Ok(())
}

fn is_expired_candidate(value: &Value, now_epoch_ms: i64) -> CognitionResult<bool> {
    let retention = value
        .get("retention")
        .and_then(Value::as_object)
        .ok_or_else(|| error("memory_box_manifest_invalid"))?;
    if retention.get("pinned").is_some_and(js_truthy) {
        return Ok(false);
    }
    let Some(expires) = retention.get("expires_at").filter(|value| js_truthy(value)) else {
        return Ok(false);
    };
    let expires = js_string(expires);
    Ok(crate::js_date::parse_date_millis(&expires, &Some)
        .is_some_and(|expires| expires <= now_epoch_ms))
}

fn all_box_owned(files: &[Value]) -> CognitionResult<bool> {
    for file in files {
        let object = file
            .as_object()
            .ok_or_else(|| error("memory_box_manifest_invalid"))?;
        if object.get("ownership").and_then(Value::as_str) != Some("box-owned") {
            return Ok(false);
        }
    }
    Ok(true)
}

fn relative_path(file: &Value) -> CognitionResult<Option<String>> {
    let object = file
        .as_object()
        .ok_or_else(|| error("memory_box_manifest_invalid"))?;
    let Some(value) = object
        .get("box_relative_path")
        .filter(|value| js_truthy(value))
    else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| error("memory_box_retention_path_unsafe"))
}

fn mark_forgotten(value: &mut Value, now_iso: &str) -> CognitionResult<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| error("memory_box_manifest_invalid"))?;
    object.insert("status".into(), json!("forgotten"));
    object.insert("updated_at".into(), json!(now_iso));
    let quality: &mut Map<String, Value> = object
        .get_mut("quality")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| error("memory_box_manifest_invalid"))?;
    let signals = quality
        .get_mut("signals")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| error("memory_box_manifest_invalid"))?;
    signals.push(json!("retention_pruned"));
    Ok(())
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
