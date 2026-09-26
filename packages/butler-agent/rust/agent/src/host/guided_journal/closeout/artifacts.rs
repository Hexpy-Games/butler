use std::collections::HashSet;

use serde_json::Value;

use crate::btcc::{ArtifactKind, BtccError, FinalArtifact, ToolJournalCloseoutRow};

use super::{invalid, safe_path, trimmed};

#[derive(Default)]
pub(super) struct ArtifactCollector {
    items: Vec<FinalArtifact>,
    seen: HashSet<String>,
}

impl ArtifactCollector {
    pub(super) fn add(&mut self, row: &ToolJournalCloseoutRow) -> Result<(), BtccError> {
        if self.items.len() == 12 {
            return Ok(());
        }
        let Some(result) = &row.result else {
            return Ok(());
        };
        if result.field("ok").map_err(invalid)? == Some("false") {
            return Ok(());
        }
        for key in ["artifacts", "verified_output_files"] {
            let Some(raw) = result.field(key).map_err(invalid)? else {
                continue;
            };
            if !raw.starts_with('[') {
                continue;
            }
            crate::json::visit_raw_array(raw, |candidate| {
                if self.items.len() == 12 {
                    return Ok(());
                }
                if let Ok(value) = serde_json::from_str::<Value>(candidate)
                    && let Some(artifact) = final_artifact(&value)
                    && self.seen.insert(artifact.safe_path_label.clone())
                {
                    self.items.push(artifact);
                }
                Ok(())
            })
            .map_err(invalid)?;
        }
        Ok(())
    }

    pub(super) fn finish(self) -> Vec<FinalArtifact> {
        self.items
    }
}

fn final_artifact(value: &Value) -> Option<FinalArtifact> {
    let item = value.as_object()?;
    let path = safe_path(item.get("path")?.as_str()?, true)?;
    let size_value = item
        .get("size_bytes")
        .filter(|value| !value.is_null())
        .or_else(|| item.get("sizeBytes"));
    let size_bytes = size_value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(|number| number.trunc() as u64);
    if size_bytes.is_some_and(|size| size > 10 * 1024 * 1024) {
        return None;
    }
    let kind = kind(
        item.get("artifact_kind")
            .filter(|value| !value.is_null())
            .or_else(|| item.get("kind")),
    );
    let kind_name = kind_name(&kind);
    let mime = item
        .get("mediaType")
        .filter(|value| !value.is_null())
        .or_else(|| item.get("mime_type"))
        .and_then(safe_text)
        .unwrap_or_else(|| mime_for(&path).to_owned());
    let created = item
        .get("modified_at")
        .filter(|value| !value.is_null())
        .or_else(|| item.get("createdAt"))
        .and_then(safe_text);
    let mut identity = String::from("{\"safePathLabel\":");
    crate::json::write_string(&path, &mut identity).ok()?;
    identity.push_str(",\"kind\":");
    crate::json::write_string(kind_name, &mut identity).ok()?;
    identity.push_str(",\"mimeType\":");
    crate::json::write_string(&mime, &mut identity).ok()?;
    if let Some(size) = size_bytes {
        identity.push_str(",\"sizeBytes\":");
        identity.push_str(&size.to_string());
    }
    if let Some(created) = &created {
        identity.push_str(",\"createdAt\":");
        crate::json::write_string(created, &mut identity).ok()?;
    }
    identity.push('}');
    Some(FinalArtifact {
        id: format!("artifact-{}", crate::btcc::digest_identity(&identity)),
        kind,
        title: path.rsplit('/').next()?.to_owned(),
        safe_path_label: path,
        mime_type: Some(mime),
        size_bytes,
        created_at: created,
    })
}

fn safe_text(value: &Value) -> Option<String> {
    let value = trimmed(value.as_str()?);
    if value.is_empty() {
        return None;
    }
    Some(
        crate::json::Utf16Slice::new(value, 0, 240)
            .utf8_lossy()
            .into_owned(),
    )
}

fn kind(value: Option<&Value>) -> ArtifactKind {
    match value.and_then(Value::as_str) {
        Some("csv_file") => ArtifactKind::CsvFile,
        Some("table_file") => ArtifactKind::TableFile,
        Some("chart_file") => ArtifactKind::ChartFile,
        Some("image") => ArtifactKind::Image,
        Some("document") => ArtifactKind::Document,
        Some("code") => ArtifactKind::Code,
        Some("report") => ArtifactKind::Report,
        Some("file") => ArtifactKind::File,
        _ => ArtifactKind::Unknown,
    }
}

fn kind_name(kind: &ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::CsvFile => "csv_file",
        ArtifactKind::TableFile => "table_file",
        ArtifactKind::ChartFile => "chart_file",
        ArtifactKind::Image => "image",
        ArtifactKind::Document => "document",
        ArtifactKind::Code => "code",
        ArtifactKind::Report => "report",
        ArtifactKind::File => "file",
        ArtifactKind::Unknown => "unknown",
    }
}

fn mime_for(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or("");
    let extension = name
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(_, extension)| extension)
        .unwrap_or("");
    match extension.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        "json" => "application/json",
        "txt" | "md" | "ts" | "tsx" | "js" | "jsx" => "text/plain",
        _ => "application/octet-stream",
    }
}
