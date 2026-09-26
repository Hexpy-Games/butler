//! Source-compatible operator access to canonical Box manifests and index.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::cognition::CognitionResult;

use super::{BoxStoreService, error, index, manifest, paths};

impl BoxStoreService {
    pub(crate) async fn operator_list(&self, limit: usize) -> CognitionResult<Vec<Value>> {
        self.with_lease("box_operator_list", move |root| {
            index::list_indexed(&root, limit)
        })
        .await
    }

    pub(crate) async fn operator_show(&self, id: &str) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("box_operator_show", move |root| {
            let Some(manifest) = read_manifest(&root, &id)? else {
                return Ok(None);
            };
            let manifest = serde_json::to_value(&manifest)
                .map_err(|_| error("memory_box_manifest_invalid"))?;
            Ok(Some(json!({
                "item": item_summary(&manifest),
                "manifest": manifest,
            })))
        })
        .await
    }

    pub(crate) async fn operator_inspect(
        &self,
        id: &str,
        include_raw: bool,
    ) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("box_operator_inspect", move |root| {
            let Some(manifest) = read_manifest(&root, &id)? else {
                return Ok(None);
            };
            let mut raw = Vec::new();
            if include_raw {
                let item_dir = root.join("items").join(&id);
                for file in &manifest.files {
                    if file.ownership != "box-owned" {
                        continue;
                    }
                    let Some(relative) = file.box_relative_path.as_deref() else {
                        continue;
                    };
                    let path = paths::validate_relative_file(&item_dir, relative)?;
                    let content = match fs::read(&path) {
                        Ok(bytes) => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
                        Err(_) => return Err(error("memory_box_content_read_failed")),
                    };
                    raw.push(json!({
                        "role": file.role,
                        "box_relative_path": relative,
                        "text": content,
                    }));
                }
            }
            let manifest = serde_json::to_value(&manifest)
                .map_err(|_| error("memory_box_manifest_invalid"))?;
            Ok(Some(json!({
                "item": item_summary(&manifest),
                "manifest": manifest,
                "raw": raw,
            })))
        })
        .await
    }

    pub(crate) async fn operator_forget(
        &self,
        id: &str,
        mode: &str,
    ) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        let mode = mode.to_owned();
        self.with_lease("box_operator_forget", move |root| {
            let Some(mut manifest) = read_manifest(&root, &id)? else {
                return Ok(None);
            };
            let item_dir = root.join("items").join(&id);
            if mode == "raw" {
                for file in &manifest.files {
                    if file.ownership != "box-owned" {
                        continue;
                    }
                    let Some(relative) = file.box_relative_path.as_deref() else {
                        continue;
                    };
                    let path = paths::validate_relative_file(&item_dir, relative)?;
                    match fs::remove_file(path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(_) => return Err(error("memory_box_content_remove_failed")),
                    }
                }
            }
            manifest.status = manifest::ItemStatus::Forgotten;
            manifest.updated_at = now_iso();
            manifest.quality.signals.push(format!("forgotten:{mode}"));
            let value = serde_json::to_value(&manifest)
                .map_err(|_| error("memory_box_manifest_write_failed"))?;
            let path = item_dir.join("manifest.json");
            let path = paths::validate_manifest_target(&path, &item_dir)?;
            manifest::write_manifest_value(&path, &value)?;
            Ok(Some(json!({
                "item": item_summary(&value),
                "mode": mode,
            })))
        })
        .await
    }
}

fn read_manifest(root: &Path, id: &str) -> CognitionResult<Option<manifest::BoxManifest>> {
    if !paths::safe_item_id(id) {
        return Err(error("memory_box_manifest_id_invalid"));
    }
    let item_dir = root.join("items").join(id);
    manifest::read_manifest_for_dir(root, &item_dir, id)
}

fn item_summary(manifest: &Value) -> Value {
    json!({
        "box_item_id": manifest["box_item_id"],
        "kind": manifest["kind"],
        "status": manifest["status"],
        "title": manifest["title"],
        "summary": manifest["summary"],
        "privacy_class": manifest.pointer("/privacy/class"),
        "retention_class": manifest.pointer("/retention/class"),
        "freshness_class": manifest.pointer("/freshness/class"),
        "created_at": manifest["created_at"],
        "captured_at": manifest["captured_at"],
        "updated_at": manifest["updated_at"],
        "tags": manifest["tags"],
        "file_count": manifest["files"].as_array().map_or(0, Vec::len),
    })
}

fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    crate::js_date::format_iso_millis(millis)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}
