use super::{invalid, safe_path, trimmed};
use butler_turn::btcc::{ArtifactKind, BtccError, FinalArtifact, ToolJournalCloseoutRow};
use serde_json::Value;

#[derive(Default)]
pub(super) struct ArtifactCollector {
    deliverables: Vec<FinalArtifact>,
    working: Vec<FinalArtifact>,
    pub(super) outputs: Vec<String>,
}
impl ArtifactCollector {
    pub(super) fn add(&mut self, row: &ToolJournalCloseoutRow) -> Result<(), BtccError> {
        let Some(result) = &row.result else {
            return Ok(());
        };
        if result.field("ok").map_err(invalid)? == Some("false") {
            return Ok(());
        }
        if row.tool_name == "output_publish"
            && let Some(raw) = result.field("output_id").map_err(invalid)?
            && let Ok(id) = serde_json::from_str::<String>(raw)
            && !self.outputs.contains(&id)
        {
            self.outputs.push(id);
        }
        let page = page_url(result)?;
        for key in ["artifacts", "verified_output_files"] {
            let Some(raw) = result.field(key).map_err(invalid)? else {
                continue;
            };
            if !raw.starts_with('[') {
                continue;
            }
            butler_core::json::visit_raw_array(raw, |candidate| {
                if let Ok(value) = serde_json::from_str::<Value>(candidate)
                    && let Some(mut artifact) = final_artifact(&value)
                {
                    artifact.source_url.clone_from(&page);
                    self.insert(artifact);
                }
                Ok(())
            })
            .map_err(invalid)?;
        }
        Ok(())
    }
    fn insert(&mut self, artifact: FinalArtifact) {
        let items = if artifact.deliverable {
            &mut self.deliverables
        } else {
            &mut self.working
        };
        if let Some(prior) = items
            .iter_mut()
            .find(|a| a.safe_path_label == artifact.safe_path_label)
        {
            *prior = artifact;
        } else if items.len() < 12 {
            items.push(artifact);
        }
    }
    pub(super) fn finish(mut self) -> Vec<FinalArtifact> {
        self.working.retain(|a| {
            !self
                .deliverables
                .iter()
                .any(|d| d.safe_path_label == a.safe_path_label)
        });
        self.deliverables
            .extend(self.working.into_iter().take(12 - self.deliverables.len()));
        self.deliverables
    }
}

/// A browser capture names the page it was taken from; its artifacts show that page.
fn page_url(result: &butler_core::json::JsonDocument) -> Result<Option<String>, BtccError> {
    let Some(raw) = result.field("untrusted_content").map_err(invalid)? else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|content| content.get("url")?.as_str().map(str::to_owned))
        .filter(|url| butler_runtime::capabilities::answer_blocks::source_identity(url).is_some()))
}

fn final_artifact(value: &Value) -> Option<FinalArtifact> {
    let item = value.as_object()?;
    let deliverable = item.get("deliverable").and_then(Value::as_bool) == Some(true);
    let path = safe_path(item.get("path")?.as_str()?, !deliverable)?;
    let size_value = item
        .get("size_bytes")
        .filter(|value| !value.is_null())
        .or_else(|| item.get("sizeBytes"));
    let size_bytes = size_value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(|number| butler_core::json::saturating_u64(number.trunc()));
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
    butler_core::json::write_string(&path, &mut identity).ok()?;
    identity.push_str(",\"kind\":");
    butler_core::json::write_string(kind_name, &mut identity).ok()?;
    identity.push_str(",\"mimeType\":");
    butler_core::json::write_string(&mime, &mut identity).ok()?;
    if let Some(size) = size_bytes {
        identity.push_str(",\"sizeBytes\":");
        identity.push_str(&size.to_string());
    }
    if let Some(created) = &created {
        identity.push_str(",\"createdAt\":");
        butler_core::json::write_string(created, &mut identity).ok()?;
    }
    identity.push('}');
    Some(FinalArtifact {
        id: format!("artifact-{}", butler_turn::btcc::digest_identity(&identity)),
        kind,
        title: item
            .get("title")
            .and_then(safe_text)
            .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(&path).to_owned()),
        source: item
            .get("source")
            .and_then(Value::as_str)
            .map(str::to_owned),
        deliverable,
        staged_path: item
            .get("staged_path")
            .and_then(Value::as_str)
            .map(str::to_owned),
        safe_path_label: path,
        mime_type: Some(mime),
        size_bytes,
        created_at: created,
        source_url: None,
    })
}

fn safe_text(value: &Value) -> Option<String> {
    let value = trimmed(value.as_str()?);
    if value.is_empty() {
        return None;
    }
    Some(
        butler_core::json::Utf16Slice::new(value, 0, 240)
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

pub(in crate::host::guided) fn mime_for(path: &str) -> &'static str {
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
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "json" => "application/json",
        "txt" | "md" | "ts" | "tsx" | "js" | "jsx" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// One matching key for both declarations and changed-file attachments.
pub(super) fn source_label(path: &str, workspace: &str) -> Option<String> {
    let path = safe_path(path, false)?;
    let path = std::path::Path::new(&path);
    let relative = if path.is_absolute() {
        path.strip_prefix(workspace).ok()?
    } else {
        path
    };
    let mut parts = Vec::new();
    for part in relative.components() {
        match part {
            std::path::Component::Normal(p) => parts.push(p.to_str()?),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Working files stay attached; declarations take the available capacity first.
pub(super) fn with_changed_files(
    mut artifacts: Vec<FinalArtifact>,
    files: &[butler_turn::btcc::ChangedFileSummary],
    workspace: &str,
) -> Vec<FinalArtifact> {
    for artifact in &mut artifacts {
        artifact.source = source_label(
            artifact
                .source
                .as_deref()
                .unwrap_or(&artifact.safe_path_label),
            workspace,
        );
    }
    artifacts.sort_by_key(|a| !a.deliverable);
    let mut seen = std::collections::HashSet::new();
    artifacts.retain(|a| {
        seen.insert(
            a.source
                .clone()
                .unwrap_or_else(|| a.safe_path_label.clone()),
        )
    });
    artifacts.truncate(12);
    for file in files {
        if artifacts.len() >= 12 {
            break;
        }
        let source = source_label(&file.path, workspace);
        let label = source.as_deref().unwrap_or(&file.path);
        if artifacts
            .iter()
            .any(|a| a.source.as_deref() == Some(label) || a.safe_path_label == file.path)
        {
            continue;
        }
        artifacts.push(FinalArtifact {
            id: format!("artifact-{}", butler_turn::btcc::digest_identity(label)),
            kind: ArtifactKind::File,
            title: label.rsplit('/').next().unwrap_or(label).to_owned(),
            mime_type: Some(mime_for(label).into()),
            staged_path: None,
            safe_path_label: std::path::Path::new(workspace)
                .join(label)
                .to_string_lossy()
                .into_owned(),
            source,
            deliverable: false,
            size_bytes: None,
            created_at: None,
            source_url: None,
        });
    }
    artifacts
}
