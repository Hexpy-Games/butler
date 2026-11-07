//! `artifactDisplay.ts` (the parts the viewer uses) and `revisionArtifact`.
use crate::ui::i18n::{Locale, Strings};
use crate::ui::source::wire::SessionArtifactSummary;
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

const IMAGE_EXTENSIONS: [&str; 6] = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const TEXT_EXTENSIONS: [&str; 9] = [
    ".csv", ".json", ".log", ".md", ".txt", ".tsv", ".xml", ".yaml", ".yml",
];
const CODE_EXTENSIONS: [&str; 10] = [
    ".css", ".go", ".java", ".js", ".jsx", ".kt", ".py", ".rs", ".ts", ".tsx",
];

/// `ArtifactPreviewMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Web,
    Html,
    Image,
    Markdown,
    Pdf,
    Text,
    Unsupported,
}

/// `artifactPreviewMode`: the file's own path decides the renderer.
pub(super) fn preview_mode(artifact: &SessionArtifactSummary) -> Mode {
    if artifact.kind == "web" {
        return Mode::Web;
    }
    let extension = [
        artifact.source_label.as_deref(),
        artifact.safe_path_label.as_deref(),
        Some(artifact.title.as_str()),
    ]
    .into_iter()
    .map(extension_of)
    .find(|extension| !extension.is_empty())
    .unwrap_or_default();
    let kind = artifact.kind.as_str();
    if kind == "image" || IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Mode::Image;
    }
    if extension == ".html" || extension == ".htm" {
        return if kind == "attachment" {
            Mode::Text
        } else {
            Mode::Html
        };
    }
    if extension == ".pdf" || kind == "report" {
        return Mode::Pdf;
    }
    if extension == ".md" {
        return Mode::Markdown;
    }
    if matches!(kind, "code" | "csv_file" | "table_file" | "document")
        || TEXT_EXTENSIONS.contains(&extension.as_str())
        || CODE_EXTENSIONS.contains(&extension.as_str())
    {
        return Mode::Text;
    }
    Mode::Unsupported
}

fn extension_of(value: Option<&str>) -> String {
    let name = value
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_owned();
    name.rfind('.')
        .map_or_else(String::new, |index| name[index..].to_owned())
}

/// `formatArtifactSize`.
fn format_size(bytes: i64) -> String {
    let size = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if size < 1024. * 1024. {
        format!("{:.1} KB", size / 1024.)
    } else {
        format!("{:.1} MB", size / (1024. * 1024.))
    }
}

/// `artifactDescription` and `artifactMeta`, joined as the viewer shows them.
pub(super) fn meta_line(artifact: &SessionArtifactSummary, cx: &App) -> String {
    let strings: &Strings = match Ds::get(cx).lang() {
        Lang::Ko => Locale::Ko.strings(),
        Lang::En => Locale::En.strings(),
    };
    let age = chrono::DateTime::parse_from_rfc3339(&artifact.created_at)
        .map(|at| strings.relative_age((chrono::Utc::now() - at.to_utc()).num_seconds().max(0)))
        .unwrap_or_default();
    [
        artifact.size_bytes.map(format_size).unwrap_or_default(),
        age,
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// `revisionArtifact`: the artifact as one of its Library versions (newest first); index 0 is
/// the artifact itself.
pub(super) fn revision_artifact(
    artifact: &SessionArtifactSummary,
    index: usize,
) -> SessionArtifactSummary {
    let Some(revision) = artifact
        .revisions
        .as_ref()
        .filter(|_| index > 0)
        .and_then(|revisions| revisions.get(index))
    else {
        return artifact.clone();
    };
    let file = &revision.file;
    SessionArtifactSummary {
        file_id: Some(file.file_id.clone()),
        url: Some(file.url.clone()),
        signed_url: file.signed_url.clone(),
        size_bytes: Some(file.size_bytes),
        safe_path_label: Some(file.safe_name.clone()),
        source_label: file
            .source_label
            .clone()
            .or_else(|| artifact.source_label.clone()),
        created_at: revision.capturedAt.clone(),
        ..artifact.clone()
    }
}
