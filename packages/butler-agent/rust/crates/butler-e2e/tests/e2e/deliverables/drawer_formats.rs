//! DELIVERABLE-DRAWER-FORMATS: PDF, Word and Excel files in the 서랍 are read as their text.
use super::*;
use crate::attachment_types::PDF;
use std::io::{Cursor, Write as _};

/// A zip package with these (name, content) entries.
fn package(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn content_types(part: &str, main_type: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/{part}\" ContentType=\"{main_type}\"/></Types>"
    )
}

#[tokio::test]
async fn drawer_pdf_and_office_files_are_read_as_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-DRAWER-FORMATS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    std::fs::write(setup.sandbox.data.join("report.pdf"), PDF)?;
    std::fs::write(
        setup.sandbox.data.join("plan.docx"),
        package(&[
            (
                "[Content_Types].xml",
                &content_types(
                    "word/document.xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                ),
            ),
            (
                "word/document.xml",
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Launch plan</w:t></w:r></w:p><w:p><w:r><w:t>Ship on</w:t><w:tab/><w:t>Friday</w:t></w:r></w:p></w:body></w:document>"#,
            ),
        ]),
    )?;
    std::fs::write(
        setup.sandbox.data.join("costs.xlsx"),
        package(&[
            (
                "[Content_Types].xml",
                &content_types(
                    "xl/workbook.xml",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                ),
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>"#,
            ),
            (
                "xl/sharedStrings.xml",
                r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Item</t></si><si><t>Cost</t></si><si><t>Lunch</t></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>"#,
            ),
        ]),
    )?;
    *script.steps.lock().unwrap() = [
        deliver("report.pdf", "Report"),
        deliver("plan.docx", "Plan"),
        deliver("costs.xlsx", "Costs"),
        done(),
    ]
    .into();
    let s = setup.start().await?;
    let (_, turn) = run_turn(&s, &script, "Deliver the files.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let docs = documents(&s).await?;
    let pdf = &docs.iter().find(|item| item["title"] == "Report").unwrap()["id"];
    let docx = &docs.iter().find(|item| item["title"] == "Plan").unwrap()["id"];
    let xlsx = &docs.iter().find(|item| item["title"] == "Costs").unwrap()["id"];
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Later"}))
            .await?;
    let other = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    *script.steps.lock().unwrap() = [
        call("library_search", json!({"read": pdf})),
        call("library_search", json!({"read": docx})),
        call("library_search", json!({"read": xlsx})),
        done(),
    ]
    .into();
    *script.prompt.lock().unwrap() = "What do the files say?".to_owned();
    let (_, turn) = s.turn(&other, "What do the files say?").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let outputs: Vec<Value> = script.requests.lock().unwrap().last().unwrap()["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| {
            let output: Value = serde_json::from_str(item["output"].as_str().unwrap()).unwrap();
            output.get("output").cloned().unwrap_or(output)
        })
        .collect();
    assert_eq!(outputs.len(), 3);
    assert_eq!(outputs[0]["text"], "Alpha PDF\n\n---\n\nBeta PDF");
    assert_eq!(outputs[1]["text"], "Launch plan\nShip on\tFriday");
    assert_eq!(outputs[2]["text"], "Item\tCost\nLunch\t12");
    s.finish().await?;
    server.abort();
    Ok(())
}
