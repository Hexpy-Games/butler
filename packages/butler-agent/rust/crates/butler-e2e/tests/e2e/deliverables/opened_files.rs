//! OPEN-IN-APP: an Office file in the drawer is stored as a binary file (the
//! App shows it as unsupported with save), and "open in app" gets a marked
//! copy of an allowlisted document only; the copies go when the Agent stops.
use super::*;
use crate::attachment_types::{PDF, upload};
use butler_platform::{data_paths::TEMPORARY, download_mark};
use std::io::{Cursor, Write as _};

const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const XLSX_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const PPTX_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const DOCM_MAIN: &str = "application/vnd.ms-word.document.macroEnabled.main+xml";

/// A compound file whose second sector starts with `stream` (an HWP 5 `FileHeader`).
fn compound(stream: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    bytes.resize(512, 0);
    bytes.extend_from_slice(stream);
    bytes.resize(1024, 0);
    bytes
}

fn hwpx() -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/hwp+zip").unwrap();
    zip.start_file("Contents/section0.xml", stored).unwrap();
    zip.write_all(b"<hs:sec/>").unwrap();
    zip.finish().unwrap().into_inner()
}

/// An Office Open XML package whose main part has `main_type`.
fn package(main_type: &str, part: &str, extra: &[&str]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("[Content_Types].xml", options).unwrap();
    write!(zip, "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/{part}\" ContentType=\"{main_type}\"/></Types>").unwrap();
    for name in std::iter::once(part).chain(extra.iter().copied()) {
        zip.start_file(name, options).unwrap();
        zip.write_all(b"<w:document/>").unwrap();
    }
    zip.finish().unwrap().into_inner()
}

async fn open(s: &Scenario, file_id: &str) -> Result<(u16, Value), HarnessError> {
    let reply =
        s.gw.post("/internal/opened-files", json!({"file_id": file_id}))
            .await?;
    let body = serde_json::from_str(&reply.text).unwrap_or(Value::Null);
    Ok((reply.status, body))
}

fn opened_dir(s: &Scenario) -> std::path::PathBuf {
    s.sandbox.data.join(TEMPORARY).join("opened-files")
}

#[tokio::test]
async fn office_file_opens_only_as_marked_allowlisted_copy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("OPEN-IN-APP")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    let docx = package(DOCX_MAIN, "word/document.xml", &[]);
    std::fs::write(setup.sandbox.data.join("plan.docx"), &docx)?;
    let mut s = setup.start().await?;
    *script.steps.lock().unwrap() = [deliver("plan.docx", "Plan"), done()].into();
    let (_, turn) = run_turn(&s, &script, "Deliver the plan.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    // The drawer item is a binary file by its content: the App previews no text for it.
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1, "{docs:?}");
    let file = &docs[0]["file"];
    assert_eq!(file["safe_name"], "plan.docx");
    assert_eq!(file["kind"], "generic", "{file}");
    let saved = s.gw.get(file["url"].as_str().unwrap()).await?;
    assert_eq!(saved.status, 200);

    let (status, body) = open(&s, file["file_id"].as_str().unwrap()).await?;
    if download_mark::supported() {
        assert_eq!(status, 201, "{body}");
        let path = std::path::PathBuf::from(body["data"]["path"].as_str().unwrap());
        assert!(path.starts_with(opened_dir(&s)), "{}", path.display());
        assert_eq!(path.file_name().unwrap(), "plan.docx");
        assert_eq!(
            std::fs::read(&path)?,
            docx,
            "the copy holds the stored bytes"
        );
        assert!(
            download_mark::is_marked(&path)?,
            "the copy is marked downloaded"
        );
    } else {
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (501, Some("open_unsupported"))
        );
    }

    // Chat attachments: only allowlisted content under its own extension.
    let refused = [
        (
            "macro.docm",
            package(DOCM_MAIN, "word/document.xml", &[]),
            "open_type_not_allowed",
        ),
        (
            "renamed.docx",
            package(DOCM_MAIN, "word/document.xml", &[]),
            "open_type_not_allowed",
        ),
        (
            "vba.docx",
            package(DOCX_MAIN, "word/document.xml", &["word/vbaProject.bin"]),
            "open_type_not_allowed",
        ),
        (
            "sheet.docx",
            package(XLSX_MAIN, "xl/workbook.xml", &[]),
            "open_type_mismatch",
        ),
        ("scan.docx", PDF.to_vec(), "open_type_mismatch"),
        (
            "legacy.hwp",
            compound(b"Microsoft Word document"),
            "open_type_not_allowed",
        ),
        ("plan.docx.exe", docx.clone(), "open_type_not_allowed"),
        ("notes.txt", b"plain text".to_vec(), "open_type_not_allowed"),
    ];
    for (name, bytes, code) in &refused {
        let attached = upload(&s, name, DOCX, bytes).await?;
        let (status, body) = open(&s, attached["file_id"].as_str().unwrap()).await?;
        if download_mark::supported() {
            assert_eq!(
                (status, body["error"]["code"].as_str()),
                (415, Some(*code)),
                "{name}: {body}"
            );
        } else {
            assert_eq!(status, 501, "{name}: {body}");
        }
    }
    let allowed = [
        ("REPORT.DOCX", docx.clone(), "REPORT.docx"),
        (
            "deck.pptx",
            package(PPTX_MAIN, "ppt/presentation.xml", &[]),
            "deck.pptx",
        ),
        (
            "budget.xlsx",
            package(XLSX_MAIN, "xl/workbook.xml", &[]),
            "budget.xlsx",
        ),
        ("scan.pdf", PDF.to_vec(), "scan.pdf"),
        ("form.hwp", compound(b"HWP Document File"), "form.hwp"),
        ("form.hwpx", hwpx(), "form.hwpx"),
    ];
    if download_mark::supported() {
        for (name, bytes, copy) in &allowed {
            let attached = upload(&s, name, "application/octet-stream", bytes).await?;
            let (status, body) = open(&s, attached["file_id"].as_str().unwrap()).await?;
            assert_eq!(status, 201, "{name}: {body}");
            let path = std::path::PathBuf::from(body["data"]["path"].as_str().unwrap());
            assert_eq!(path.file_name().unwrap(), *copy, "{name}");
            assert!(
                download_mark::is_marked(&path)?,
                "{name}: the copy is marked downloaded"
            );
        }
        let folders = std::fs::read_dir(opened_dir(&s))?.count();
        assert_eq!(folders, 1 + allowed.len(), "one folder per opened copy");
        let (status, _) = open(&s, "file-00000000-0000-0000-0000-000000000000").await?;
        assert_eq!(status, 404, "an unknown id opens nothing");
    }

    s.restart().await?;
    assert!(
        !opened_dir(&s).exists(),
        "copies are removed when the Agent stops"
    );
    server.abort();
    Ok(())
}
