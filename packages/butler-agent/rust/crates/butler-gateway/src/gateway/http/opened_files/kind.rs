//! Which stored files may open in another app: the document types on the
//! allowlist, decided by the bytes and matching the file's own extension.
//! Anything else, macro-enabled documents included, is refused.
use std::io::{Cursor, Read};

/// An allowlisted document type, verified from the file's content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OpenKind {
    Pdf,
    Docx,
    Xlsx,
    Pptx,
    Hwp,
    Hwpx,
}

/// Why a file may not open in another app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The name or the content is not an allowlisted type (or carries macros).
    NotAllowed,
    /// The content is an allowlisted type other than the name says.
    Mismatch,
}

const ALLOWED: [OpenKind; 6] = [
    OpenKind::Pdf,
    OpenKind::Docx,
    OpenKind::Xlsx,
    OpenKind::Pptx,
    OpenKind::Hwp,
    OpenKind::Hwpx,
];
const OOXML_MAIN: [(&str, OpenKind); 3] = [
    (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        OpenKind::Docx,
    ),
    (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        OpenKind::Xlsx,
    ),
    (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        OpenKind::Pptx,
    ),
];
const CFB_MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const HWP_SIGNATURE: &[u8] = b"HWP Document File";
const HWPX_MIMETYPE: &[u8] = b"application/hwp+zip";
/// Package parts read to decide the type; larger ones are not a document.
const PART_LIMIT: u64 = 1024 * 1024;

impl OpenKind {
    /// The extension the copy is written with (lowercase, no dot).
    pub(super) fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
            Self::Hwp => "hwp",
            Self::Hwpx => "hwpx",
        }
    }
}

/// The verified type of the file `name` holding `bytes`.
pub(super) fn verify(name: &str, bytes: &[u8]) -> Result<OpenKind, Refusal> {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or(Refusal::NotAllowed)?;
    let named = ALLOWED
        .into_iter()
        .find(|kind| kind.extension() == extension)
        .ok_or(Refusal::NotAllowed)?;
    let content = sniff(bytes).ok_or(Refusal::NotAllowed)?;
    if content == named {
        Ok(content)
    } else {
        Err(Refusal::Mismatch)
    }
}

fn sniff(bytes: &[u8]) -> Option<OpenKind> {
    if bytes.starts_with(b"%PDF-") {
        Some(OpenKind::Pdf)
    } else if bytes.starts_with(CFB_MAGIC) {
        hwp(bytes).then_some(OpenKind::Hwp)
    } else if bytes.starts_with(b"PK\x03\x04") {
        package(bytes)
    } else {
        None
    }
}

/// An HWP 5 compound file: its `FileHeader` stream starts a sector with the
/// signature.
fn hwp(bytes: &[u8]) -> bool {
    bytes
        .chunks(512)
        .skip(1)
        .any(|sector| sector.starts_with(HWP_SIGNATURE))
}

/// A ZIP package: HWPX by its `mimetype` part, otherwise exactly one
/// Office Open XML main part. A macro part refuses the whole package.
fn package(bytes: &[u8]) -> Option<OpenKind> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let names: Vec<String> = archive.file_names().map(str::to_owned).collect();
    if names.iter().any(|name| {
        let name = name.to_ascii_lowercase();
        name.ends_with("vbaproject.bin") || name.ends_with("vbadata.xml")
    }) {
        return None;
    }
    let mut part = |wanted: &str| {
        let name = names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(wanted))?;
        let mut content = Vec::new();
        archive
            .by_name(name)
            .ok()?
            .take(PART_LIMIT + 1)
            .read_to_end(&mut content)
            .ok()?;
        (content.len() as u64 <= PART_LIMIT).then_some(content)
    };
    if part("mimetype").is_some_and(|mime| mime.trim_ascii() == HWPX_MIMETYPE) {
        return Some(OpenKind::Hwpx);
    }
    let types = String::from_utf8(part("[Content_Types].xml")?).ok()?;
    if types.to_ascii_lowercase().contains("macroenabled") {
        return None;
    }
    let mut found = OOXML_MAIN
        .into_iter()
        .filter(|(mime, _)| types.contains(mime))
        .map(|(_, kind)| kind);
    match (found.next(), found.next()) {
        (Some(kind), None) => Some(kind),
        _ => None,
    }
}
