//! ATT-TYPES-01: arbitrary uploads are routed by their content.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use super::access_tiers::{delivered, stub};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    io::{Cursor, Write},
    path::Path,
};
pub(super) const PDF: &[u8] =
    include_bytes!("../../../butler-runtime/src/context/pdf/two-pages.pdf");

pub(super) async fn upload(
    s: &Scenario,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<Value, HarnessError> {
    let reply = s.gw.upload(name, mime, bytes, Some("general")).await?;
    assert_eq!(reply.status, 201, "{name}: {}", reply.text);
    Ok(reply.data()["file"].clone())
}
pub(super) async fn send(
    s: &Scenario,
    prompt: &str,
    files: &[Value],
) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general", "text":prompt,
        "attachments": files.iter().map(|f| json!({"file_id":f["file_id"]})).collect::<Vec<_>>(),
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    s.gw.accepted_turn(reply.data()).await
}
pub(super) fn input_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            if let Some(text) = item["content"].as_str() {
                return text.to_owned();
            }
            item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub(super) fn file_path(s: &Scenario, file: &Value) -> std::path::PathBuf {
    s.sandbox
        .data
        .join("app-server")
        .join("message-files")
        .join(file["file_id"].as_str().unwrap())
}
fn small_zip() -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("content.xml", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"<document>archive content</document>")
        .unwrap();
    zip.finish().unwrap().into_inner()
}

#[tokio::test]
async fn any_file_attaches_by_content() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("ATT-TYPES-01")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let mut utf16 = vec![0xff, 0xfe];
    utf16.extend("SRT-MARKER\n안녕".encode_utf16().flat_map(u16::to_le_bytes));
    let mut compound = vec![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    compound.extend(vec![0; 504]);
    let cases = vec![
        (
            "data.xyz",
            "application/octet-stream",
            (0u8..=255).cycle().take(4096).collect(),
            "generic",
            "application/octet-stream",
        ),
        (
            "report.hwp",
            "application/x-hwp",
            compound,
            "generic",
            "application/x-hwp",
        ),
        (
            "report.hwpx",
            "application/hwp+zip",
            small_zip(),
            "generic",
            "application/hwp+zip",
        ),
        (
            "doc.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            small_zip(),
            "generic",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        (
            "sheet.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            small_zip(),
            "generic",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        (
            "schema.proto",
            "application/octet-stream",
            "message 안녕 こんにちは PROTO-MARKER".as_bytes().to_vec(),
            "text",
            "text/plain",
        ),
        (
            "notes.srt",
            "application/x-subrip",
            utf16,
            "text",
            "application/x-subrip",
        ),
        (
            "spoof.txt",
            "text/plain",
            b"abc\0\x01def".to_vec(),
            "generic",
            "application/octet-stream",
        ),
        (
            "fake.pdf",
            "application/pdf",
            b"not a pdf\0\x01".to_vec(),
            "generic",
            "application/octet-stream",
        ),
        (
            "legacy.txt",
            "text/plain",
            b"Legacy \xc7\xd1\xb1\xdb\n".to_vec(),
            "generic",
            "application/octet-stream",
        ),
        (
            "scan",
            "application/octet-stream",
            PDF.to_vec(),
            "generic",
            "application/pdf",
        ),
    ];
    let mut files = Vec::new();
    for (name, declared, bytes, kind, mime) in &cases {
        let file = upload(&s, name, declared, bytes).await?;
        assert_eq!(file["kind"], *kind, "{name}");
        assert_eq!(file["mime_type"], *mime, "{name}");
        files.push(file);
    }
    let id = send(&s, "Inspect the attached files.", &files).await?;
    delivered(&s, "general", &id).await?;
    let request = script.requests.lock().unwrap()[0].clone();
    let text = input_text(&request);
    for index in [0, 1, 2, 3, 4, 7, 8, 9] {
        let (name, _, bytes, _, mime) = &cases[index];
        let file = &files[index];
        let file_id = file["file_id"].as_str().unwrap();
        let block = format!(
            "### Attachment Not Inlined: {name}\nAttachment ID: {file_id}\nType: {mime}, {} bytes\nPath: {}\nIts content is not shown inline (not decoded as text).",
            bytes.len(),
            file_path(&s, file).display()
        );
        assert!(text.contains(&block), "missing {block}: {text}");
        assert!(
            !text.contains(&format!("### Attachment Content: {name}")),
            "{text}"
        );
    }
    let data_id = files[0]["file_id"].as_str().unwrap();
    assert!(text.contains(&format!(
        "- data.xyz (binary, application/octet-stream, 4096 bytes, id: {data_id}, path: "
    )));
    assert!(
        text.contains(
            &Path::new("app-server")
                .join("message-files")
                .join(data_id)
                .display()
                .to_string()
        )
    );
    assert!(text.contains("Type: application/octet-stream, 4096 bytes"));
    assert!(text.contains("Its content is not shown inline (not decoded as text)."));
    for marker in [
        "### Attachment Content: schema.proto",
        "PROTO-MARKER",
        "안녕",
        "### Attachment Content: notes.srt",
        "SRT-MARKER",
        "Full extracted text file",
        "Alpha PDF",
        "Beta PDF",
    ] {
        assert!(text.contains(marker), "missing {marker}: {text}");
    }
    assert!(!file_path(&s, &files[8]).with_extension("txt").exists());
    let root = s.sandbox.data.join("app-server/message-files");
    let count = std::fs::read_dir(&root)?.count();
    for (name, bytes, status, code) in [
        (
            "big.bin",
            vec![0; 10 * 1024 * 1024 + 1],
            413,
            "message_file_too_large",
        ),
        ("e.bin", vec![], 400, "message_file_empty"),
    ] {
        let reply =
            s.gw.upload(name, "application/octet-stream", &bytes, Some("general"))
                .await?;
        assert_eq!(reply.status, status, "{}", reply.text);
        assert_eq!(reply.error_code(), Some(code));
    }
    assert_eq!(std::fs::read_dir(root)?.count(), count);
    s.finish().await?;
    server.abort();
    Ok(())
}
