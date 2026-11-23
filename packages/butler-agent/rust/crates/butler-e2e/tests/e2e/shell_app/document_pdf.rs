use super::live_turns::ready_workspace;
use super::{ChatBehavior, HarnessError, SERIAL, SHOTS, Sandbox, Shell, gateway, json, nonempty};

/// SHELL-APP-29 — Export as PDF from the document page writes a Letter PDF with the title, Korean text and code.
#[tokio::test]
async fn shell_app_29_document_pdf_export() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    butler_e2e::skip_unless!(
        std::process::Command::new("pdftotext")
            .arg("-v")
            .output()
            .is_ok(),
        "pdftotext is not on PATH"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-29-document-pdf-export")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    crate::documents::seed_image(&sandbox)?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "size 1400 900",
            "wait 600",
        ])
        .await?;
    let reply = gateway(&shell.launch)
        .post(
            "/documents",
            json!({
                "title": "Quarterly Report",
                "body": include_str!("document_pdf/fixtures/body.md"),
                "author": "user",
            }),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let document = format!(
        "document {}",
        reply.data()["id"].as_str().expect("document id")
    );
    shell
        .run(&[
            &document,
            "wait-anchor document-export-button",
            "click document-export-button",
            "wait-anchor document-export-item-0-1",
            "click document-export-item-0-1",
        ])
        .await?;

    let out = sandbox.root.join("out");
    std::fs::create_dir_all(&out)?;
    let pdf = out.join("Quarterly Report.pdf");
    shell
        .run(&[
            &format!("save-path {}", pdf.display()),
            &format!("wait-file {}", pdf.display()),
            "app-quit",
        ])
        .await?;
    shell.finish().await?;

    let bytes = std::fs::read(&pdf)?;
    assert!(bytes.starts_with(b"%PDF-"));
    let output = std::process::Command::new("pdftotext")
        .args(["-enc", "UTF-8"])
        .arg(&pdf)
        .arg("-")
        .output()?;
    let doc = lopdf::Document::load_mem(&bytes).expect("valid PDF");
    let id = *doc.get_pages().get(&1).expect("first page");
    let page = doc.get_dictionary(id).expect("page dictionary");
    let media_box = page
        .get(b"MediaBox")
        .expect("MediaBox")
        .as_array()
        .expect("array");
    let dimensions: Vec<_> = media_box
        .iter()
        .map(|number| number.as_float().expect("number"))
        .collect();
    assert_eq!(dimensions, [0., 0., 612., 792.]);

    assert!(
        output.status.success(),
        "pdftotext failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    let compact = text.replace(char::is_whitespace, "");
    for expected in [
        "Quarterly Report",
        "분기 매출이 증가했습니다",
        "fn quarterly_total() -> u32 { 42 }",
    ] {
        let expected = expected.replace(char::is_whitespace, "");
        assert!(
            compact.contains(&expected),
            "missing {expected:?} in {text:?}"
        );
    }
    sandbox.mark_success();
    Ok(())
}
