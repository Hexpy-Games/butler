//! Bounded public fields from the accepted BTCC terminal payload.

use serde_json::{Map, Value};

use crate::btcc::FinalArtifact;

pub(super) fn artifacts(source: &[FinalArtifact]) -> Vec<Value> {
    source
        .iter()
        .take(12)
        .enumerate()
        .map(|(index, artifact)| {
            let mut projected = Map::new();
            projected.insert(
                "id".into(),
                text(&artifact.id)
                    .unwrap_or_else(|| format!("artifact-{}", index + 1))
                    .into(),
            );
            projected.insert(
                "kind".into(),
                serde_json::to_value(&artifact.kind).unwrap_or(Value::String("unknown".into())),
            );
            projected.insert(
                "title".into(),
                text(&artifact.title)
                    .unwrap_or_else(|| format!("Artifact {}", index + 1))
                    .into(),
            );
            if let Some(value) = text(&artifact.safe_path_label) {
                projected.insert("safePathLabel".into(), value.into());
            }
            if let Some(value) = artifact.mime_type.as_deref().and_then(text) {
                projected.insert("mimeType".into(), value.into());
            }
            if let Some(value) = artifact.size_bytes {
                projected.insert("sizeBytes".into(), value.into());
            }
            if let Some(value) = artifact.created_at.as_deref().and_then(text) {
                projected.insert("createdAt".into(), value.into());
            }
            Value::Object(projected)
        })
        .collect()
}

pub(super) fn changed_files(source: &[Value]) -> Vec<Value> {
    source
        .iter()
        .filter(|candidate| {
            candidate.as_object().is_some_and(|file| {
                file.get("path").is_some_and(Value::is_string)
                    && file.get("lines").is_some_and(Value::is_array)
            })
        })
        .take(40)
        .cloned()
        .collect()
}

pub(super) fn plan(source: Option<&Value>) -> Option<Value> {
    let input = source?.as_object()?;
    if input.get("kind")?.as_str()? != "plan" {
        return None;
    }
    let mut projected = Map::new();
    projected.insert("kind".into(), "plan".into());
    for key in ["id", "title", "status"] {
        projected.insert(key.into(), text(input.get(key)?.as_str()?)?.into());
    }
    let body = input.get("body")?.as_str()?;
    if crate::public_text::trim_js_whitespace(body).is_empty() {
        return None;
    }
    projected.insert("body".into(), body.into());
    if let Some(path) = input.get("path").and_then(Value::as_str).and_then(text) {
        projected.insert("path".into(), path.into());
    }
    Some(Value::Object(projected))
}

pub(super) fn text(value: &str) -> Option<String> {
    let trimmed = crate::public_text::trim_js_whitespace(value);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}
