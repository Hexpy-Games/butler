//! Readable text of a stored file, chosen by its bytes: a PDF's text layer, the text
//! runs of an Office Open XML, OpenDocument or HWPX package, or UTF-8 text as is.

use std::io::{Cursor, Read};

use butler_core::public_text::trim_js_whitespace;
use roxmltree::{Document, Node};
use zip::ZipArchive;

use super::pdf::{PdfTextError, extract_pdf_text};

/// Decompressed XML read from one package, at most.
const MAX_PACKAGE_XML: u64 = 16 * 1024 * 1024;
const PART_SEPARATOR: &str = "\n\n---\n\n";
const ODF_TEXT: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
/// Body parts as (prefix, suffix) with an optional number between: Word, PowerPoint
/// slides, Excel sheets, OpenDocument, HWPX sections.
const CONTENT_PARTS: [(&str, &str); 5] = [
    ("word/document.xml", ""),
    ("ppt/slides/slide", ".xml"),
    ("xl/worksheets/sheet", ".xml"),
    ("content.xml", ""),
    ("Contents/section", ".xml"),
];

/// Why a stored file yielded no text.
#[derive(Debug, thiserror::Error)]
pub enum DocumentTextError {
    #[error(transparent)]
    Pdf(#[from] PdfTextError),
    #[error(
        "This file is not text, PDF, or a Word, Excel, PowerPoint, OpenDocument or HWPX document; its contents have not been read."
    )]
    Unsupported,
    #[error("The document could not be read; it may be damaged or too large.")]
    Damaged,
}

/// The caller runs this on a blocking thread and owns the size limit of `bytes`.
pub fn document_text(bytes: Vec<u8>) -> Result<String, DocumentTextError> {
    if bytes.starts_with(b"%PDF-") {
        return Ok(extract_pdf_text(&bytes)?.text);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return package_text(&bytes);
    }
    String::from_utf8(bytes).map_err(|_| DocumentTextError::Unsupported)
}

fn package_text(bytes: &[u8]) -> Result<String, DocumentTextError> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|_| DocumentTextError::Unsupported)?;
    let mut parts: Vec<String> = archive
        .file_names()
        .filter(|name| content_part(name))
        .map(str::to_owned)
        .collect();
    if parts.is_empty() {
        return Err(DocumentTextError::Unsupported);
    }
    parts.sort_by(|a, b| (a.len(), a).cmp(&(b.len(), b)));
    let mut budget = MAX_PACKAGE_XML;
    let shared = match archive.index_for_name("xl/sharedStrings.xml") {
        Some(_) => shared_strings(&read_part(
            &mut archive,
            "xl/sharedStrings.xml",
            &mut budget,
        )?)?,
        None => Vec::new(),
    };
    let mut texts = Vec::new();
    for name in &parts {
        let xml = read_part(&mut archive, name, &mut budget)?;
        let document = Document::parse(&xml).map_err(|_| DocumentTextError::Damaged)?;
        let text = xml_text(&document, &shared);
        let text = trim_js_whitespace(&text);
        if !text.is_empty() {
            texts.push(text.to_owned());
        }
    }
    Ok(texts.join(PART_SEPARATOR))
}

fn content_part(name: &str) -> bool {
    CONTENT_PARTS.iter().any(|(prefix, suffix)| {
        name.strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(suffix))
            .is_some_and(|number| number.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

fn read_part(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    budget: &mut u64,
) -> Result<String, DocumentTextError> {
    let part = archive
        .by_name(name)
        .map_err(|_| DocumentTextError::Damaged)?;
    let mut xml = String::new();
    part.take(*budget + 1)
        .read_to_string(&mut xml)
        .map_err(|_| DocumentTextError::Damaged)?;
    *budget = budget
        .checked_sub(xml.len() as u64)
        .ok_or(DocumentTextError::Damaged)?;
    Ok(xml)
}

/// Excel's shared strings: each `si` is the text of its `t` runs.
fn shared_strings(xml: &str) -> Result<Vec<String>, DocumentTextError> {
    let document = Document::parse(xml).map_err(|_| DocumentTextError::Damaged)?;
    Ok(document
        .root_element()
        .children()
        .filter(|node| node.tag_name().name() == "si")
        .map(|si| {
            si.descendants()
                .filter(|node| node.tag_name().name() == "t")
                .filter_map(|node| node.text())
                .collect()
        })
        .collect())
}

/// Text runs in document order. Paragraphs, headings and rows start a new line; tabs
/// and breaks keep their meaning; a cell after another cell starts with a tab.
fn xml_text(document: &Document, shared: &[String]) -> String {
    let mut text = String::new();
    for node in document.root().descendants() {
        if node.is_text() {
            push_run(&mut text, node, shared);
            continue;
        }
        match node.tag_name().name() {
            "p" | "h" | "row" | "br" | "line-break" => text.push('\n'),
            "tab"
                if node
                    .parent_element()
                    .is_none_or(|p| p.tag_name().name() != "tabs") =>
            {
                text.push('\t');
            }
            "c" if node.prev_sibling_element().is_some() => text.push('\t'),
            _ => {}
        }
    }
    text
}

/// Office Open XML and HWPX keep text in `t` elements, OpenDocument in its text
/// namespace, Excel cell values in `v` (a shared-string index when the cell has `t="s"`).
fn push_run(text: &mut String, node: Node, shared: &[String]) {
    let (Some(parent), Some(value)) = (node.parent_element(), node.text()) else {
        return;
    };
    let name = parent.tag_name().name();
    if name == "v" && parent.parent_element().and_then(|cell| cell.attribute("t")) == Some("s") {
        if let Some(string) = value
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|i| shared.get(i))
        {
            text.push_str(string);
        }
    } else if matches!(name, "t" | "v") || parent.tag_name().namespace() == Some(ODF_TEXT) {
        text.push_str(value);
    }
}
