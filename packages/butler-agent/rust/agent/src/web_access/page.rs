use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::html::title_from_html;
use super::service::WebAccessError;

const CHUNK_SIZE: usize = 1_500;
const CHUNK_OVERLAP: usize = 180;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PageRead {
    pub(super) reader: String,
    pub(super) requested_url: String,
    pub(super) final_url: String,
    pub(super) ok: bool,
    pub(super) status: Option<u16>,
    pub(super) title: Option<String>,
    pub(super) text: String,
    pub(super) markdown: String,
    pub(super) method: String,
    pub(super) duration_ms: u64,
    pub(super) warnings: Vec<String>,
    pub(super) render_recommended: bool,
    pub(super) error: Option<String>,
    pub(super) chunks: Vec<EvidenceChunk>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct EvidenceChunk {
    pub(super) id: String,
    pub(super) index: usize,
    pub(super) title: Option<String>,
    pub(super) url: String,
    pub(super) text: String,
    pub(super) char_count: usize,
}

impl PageRead {
    pub(super) fn unavailable(
        requested_url: &str,
        final_url: &str,
        reader: &str,
        message: &str,
        warning: &str,
    ) -> Self {
        Self {
            reader: reader.into(),
            requested_url: requested_url.into(),
            final_url: final_url.into(),
            ok: false,
            status: None,
            title: None,
            text: String::new(),
            markdown: String::new(),
            method: "raw-html".into(),
            duration_ms: 0,
            warnings: vec![warning.into()],
            render_recommended: false,
            error: Some(message.into()),
            chunks: Vec::new(),
        }
    }
}

pub(super) fn extract_page(
    requested_url: &str,
    final_url: &str,
    status: u16,
    response_ok: bool,
    content_type: Option<&str>,
    bytes: &[u8],
    _backend: &str,
) -> Result<PageRead, WebAccessError> {
    let kind = document_kind(content_type, bytes);
    let (title, text, markdown, method, warnings, error) = match kind {
        DocumentKind::Unsupported => (
            None,
            String::new(),
            String::new(),
            "unsupported",
            vec!["unsupported-document-type".into()],
            Some("Unsupported document type; its contents have not been read.".into()),
        ),
        DocumentKind::Pdf => match crate::context::extract_pdf_text(bytes) {
            Ok(pdf) => (
                pdf.title,
                pdf.text.clone(),
                pdf.text,
                "pdf",
                Vec::new(),
                None,
            ),
            Err(crate::context::PdfTextError::Scanned) => (
                None,
                String::new(),
                String::new(),
                "pdf",
                vec!["pdf-text-unavailable".into()],
                Some("PDF text is unavailable; this may be a scanned document.".into()),
            ),
            Err(crate::context::PdfTextError::Extraction) => (
                None,
                String::new(),
                String::new(),
                "pdf",
                vec!["pdf-text-unavailable".into()],
                Some("PDF is damaged or unsupported; its contents have not been read.".into()),
            ),
        },
        DocumentKind::Text => {
            let text = String::from_utf8_lossy(bytes).trim().to_owned();
            let markdown = format!("```\n{text}\n```");
            let method = if url::Url::parse(final_url)
                .is_ok_and(|url| url.host_str() == Some("raw.githubusercontent.com"))
            {
                "github-raw"
            } else {
                "plain-text"
            };
            (None, text, markdown, method, Vec::new(), None)
        }
        DocumentKind::Html => {
            let body = String::from_utf8_lossy(bytes);
            let extracted = super::html::extract_readable_html(&body, final_url);
            let text = extracted.text;
            let title = extracted.title.or_else(|| title_from_html(&body));
            let mut warnings = page_warnings(&body, &text, content_type);
            if extracted.method == "raw-html" {
                warnings.push("readability-fallback-to-raw-html".into());
            }
            (
                title,
                text,
                extracted.markdown,
                extracted.method,
                warnings,
                None,
            )
        }
    };
    let text_len = text.encode_utf16().count();
    let mut warnings = warnings;
    if text_len > 0 && text_len < 500 && !warnings.iter().any(|item| item == "tiny-content") {
        warnings.push("tiny-content".into());
    }
    let render_recommended = !matches!(method, "pdf" | "unsupported" | "plain-text")
        && (warnings.iter().any(|value| {
            matches!(
                value.as_str(),
                "likely-csr-app-shell"
                    | "javascript-required"
                    | "cloudflare-challenge"
                    | "possible-login-or-block"
            )
        }) || (warnings.iter().any(|value| value == "tiny-content")
            && text.to_ascii_lowercase().contains("javascript"))
            || (text_len < 50 && method != "github-raw"));
    warnings.sort();
    warnings.dedup();
    let chunks = chunk_evidence(&markdown, title.as_deref(), final_url);
    let ok = response_ok && !text.trim().is_empty() && error.is_none();
    Ok(PageRead {
        reader: "butler-lightweight".into(),
        requested_url: requested_url.into(),
        final_url: final_url.into(),
        ok,
        status: Some(status),
        title,
        text,
        markdown,
        method: method.into(),
        duration_ms: 0,
        warnings,
        render_recommended,
        error,
        chunks,
    })
}

#[derive(Clone, Copy)]
enum DocumentKind {
    Html,
    Text,
    Pdf,
    Unsupported,
}

fn document_kind(content_type: Option<&str>, bytes: &[u8]) -> DocumentKind {
    let mime = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if mime == "application/pdf" || bytes.starts_with(b"%PDF-") {
        return DocumentKind::Pdf;
    }
    if matches!(mime.as_str(), "text/html" | "application/xhtml+xml") {
        return DocumentKind::Html;
    }
    if mime.starts_with("text/")
        || mime == "application/json"
        || mime == "application/xml"
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || mime == "application/javascript"
    {
        return DocumentKind::Text;
    }
    let prefix = String::from_utf8_lossy(bytes.get(..1_024).unwrap_or(bytes))
        .trim_start()
        .to_ascii_lowercase();
    if prefix.starts_with("<!doctype html")
        || prefix.starts_with("<html")
        || prefix.starts_with("<head")
        || prefix.starts_with("<body")
        || prefix.starts_with("<article")
    {
        return DocumentKind::Html;
    }
    if std::str::from_utf8(bytes).is_ok_and(|text| {
        !text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\r' | '\n' | '\t'))
    }) {
        return DocumentKind::Text;
    }
    DocumentKind::Unsupported
}

fn page_warnings(body: &str, text: &str, content_type: Option<&str>) -> Vec<String> {
    let lower = body.to_ascii_lowercase();
    let mut warnings = Vec::new();
    if lower.matches("<script").count() >= 8 && text.encode_utf16().count() < 1_000 {
        warnings.push("likely-csr-app-shell".into());
    }
    if [
        "enable javascript",
        "requires javascript",
        "please enable javascript",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
    {
        warnings.push("javascript-required".into());
    }
    if [
        "challenge-platform",
        "__cf_chl",
        "turnstile",
        "just a moment",
        "verification successful",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
    {
        warnings.push("cloudflare-challenge".into());
    }
    let prefix = text
        .chars()
        .take(2_000)
        .collect::<String>()
        .to_ascii_lowercase();
    if ["login", "sign in", "captcha", "access denied", "blocked"]
        .iter()
        .any(|phrase| prefix.contains(phrase))
    {
        warnings.push("possible-login-or-block".into());
    }
    if let Some(content_type) = content_type
        && !["html", "text", "json", "xml", "javascript", "typescript"]
            .iter()
            .any(|kind| content_type.to_ascii_lowercase().contains(kind))
    {
        warnings.push(format!("unexpected-content-type:{content_type}"));
    }
    warnings
}

fn chunk_evidence(markdown: &str, title: Option<&str>, url: &str) -> Vec<EvidenceChunk> {
    let text = markdown.trim();
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < text.encode_utf16().count() {
        let candidate = crate::json::Utf16Slice::new(text, offset, CHUNK_SIZE)
            .utf8_lossy()
            .into_owned();
        let candidate_units = candidate.encode_utf16().count();
        let end = offset.saturating_add(candidate_units);
        let mut end = end.min(text.encode_utf16().count());
        if end < text.encode_utf16().count()
            && let Some(boundary) = candidate.rfind("\n\n")
        {
            let before = candidate[..boundary].encode_utf16().count();
            if before > CHUNK_SIZE * 45 / 100 {
                end = offset + before;
            }
        }
        let slice = crate::json::Utf16Slice::new(text, offset, end.saturating_sub(offset))
            .utf8_lossy()
            .into_owned();
        let chunk_text = slice.trim().to_owned();
        if !chunk_text.is_empty() {
            let index = chunks.len();
            let identity = format!("{url}:{index}:{}", utf16_prefix(&chunk_text, 160));
            chunks.push(EvidenceChunk {
                id: format!("ev_{}", simple_hash(&identity)),
                index,
                title: title.map(str::to_owned),
                url: url.into(),
                char_count: chunk_text.encode_utf16().count(),
                text: chunk_text,
            });
        }
        if end >= text.encode_utf16().count() {
            break;
        }
        offset = end.saturating_sub(CHUNK_OVERLAP).max(offset + 1);
    }
    chunks
}

fn utf16_prefix(value: &str, max: usize) -> String {
    crate::json::Utf16Slice::new(value, 0, max)
        .utf8_lossy()
        .into_owned()
}

fn simple_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{:x}", digest)[..16].to_owned()
}
