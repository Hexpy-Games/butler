//! Which stored files may open in another app: documents, raster images and
//! plain text, verified from the bytes and matching the file's own extension.
//! Anything else, macro-enabled documents included, is revealed.
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

/// Only positively verified content may open; everything else is revealed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Handling {
    /// Opens; the copy is written with this lowercase extension.
    Open(String),
    Reveal,
}

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

/// Verify both the named extension and the content. Documents require the
/// downloaded mark; raster images and UTF-8 text can open without it.
pub(super) fn verify(name: &str, bytes: &[u8]) -> Handling {
    let extension = name.rsplit_once('.').map_or("", |(_, ext)| ext);
    let extension = extension.to_ascii_lowercase();
    let verified = match extension.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "md" | "markdown" | "txt" | "csv" => {
            !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
        }
        "pdf" | "docx" | "xlsx" | "pptx" | "hwp" | "hwpx" => {
            butler_platform::download_mark::supported()
                && sniff(bytes).is_some_and(|kind| kind.extension() == extension)
        }
        _ => false,
    };
    if verified {
        Handling::Open(extension)
    } else {
        Handling::Reveal
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
