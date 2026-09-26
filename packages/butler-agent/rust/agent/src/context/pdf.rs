//! PDF text extraction for the upload owner's tracked blocking operation.

use lopdf::{Document, decode_text_string};

use crate::public_text::trim_js_whitespace;

const SCANNED_MESSAGE: &str = "PDF text is unavailable. This may be a scanned document; OCR and page images have not been read.";
const EXTRACTION_MESSAGE: &str = "[PDF text could not be extracted. The file may be encrypted or damaged; its contents have not been read.]";
const PAGE_SEPARATOR: &str = "\n\n---\n\n";

pub(crate) struct ExtractedPdfText {
    pub(crate) text: String,
    pub(crate) title: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PdfTextError {
    Scanned,
    Extraction,
}

/// The caller owns the upload bytes and blocking admission. PDF content expansion is not
/// capped here because the source extractor has no decompressed-text/output cap.
pub(crate) fn extract_pdf_text(bytes: &[u8]) -> Result<ExtractedPdfText, PdfTextError> {
    let document = Document::load_mem(bytes).map_err(|_| PdfTextError::Extraction)?;
    let mut text = String::new();
    let mut has_text = false;
    for page_number in document.get_pages().keys() {
        let page = document
            .extract_text(&[*page_number])
            .map_err(|_| PdfTextError::Extraction)?;
        let page = trim_js_whitespace(&page);
        has_text |= !page.is_empty();
        if !text.is_empty() || *page_number > 1 {
            text.push_str(PAGE_SEPARATOR);
        }
        text.push_str(page);
    }
    if !has_text {
        return Err(PdfTextError::Scanned);
    }
    let text = trim_js_whitespace(&text).to_owned();
    Ok(ExtractedPdfText {
        text,
        title: title(&document),
    })
}

/// Matches preparePdfAttachment's persisted sidecar contents, including its two error classes.
pub(crate) fn pdf_sidecar_text(result: Result<ExtractedPdfText, PdfTextError>) -> String {
    match result {
        Ok(extracted) => extracted.text,
        Err(PdfTextError::Scanned) => format!("[{SCANNED_MESSAGE}]"),
        Err(PdfTextError::Extraction) => EXTRACTION_MESSAGE.to_owned(),
    }
}

fn title(document: &Document) -> Option<String> {
    let info = document
        .trailer
        .get_deref(b"Info", document)
        .ok()?
        .as_dict()
        .ok()?;
    let title = decode_text_string(info.get_deref(b"Title", document).ok()?).ok()?;
    let title = trim_js_whitespace(&title);
    (!title.is_empty()).then(|| title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::extract_pdf_text;

    #[test]
    fn two_page_source_oracle() {
        // Actual Bun extractPdfText on this PDF: {text:"Alpha PDF\n\n---\n\nBeta PDF",title:"Demo Title"}.
        let result = extract_pdf_text(include_bytes!("pdf/two-pages.pdf")).unwrap();
        assert_eq!(result.text, "Alpha PDF\n\n---\n\nBeta PDF");
        assert_eq!(result.title.as_deref(), Some("Demo Title"));
    }
}
