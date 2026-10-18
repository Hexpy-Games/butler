//! ATT-REACH-01: file-read approval follows this turn's attachment identities.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use super::{
    access_tiers::{
        approve, assert_counts, delivered, outputs,
        stub::{self, call},
    },
    attachment_types::{PDF, file_path, input_text, send, upload},
};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn attachment_reads_skip_approval_only_for_this_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("ATT-REACH-01")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    let mut big = b"aaaaaaaaa\n".repeat(59_998);
    big.extend_from_slice(b"TAIL-MARKER123456789");
    let big = upload(&s, "big.log", "text/plain", &big).await?;
    let binary = upload(&s, "data.xyz", "application/octet-stream", b"binary\0\x01").await?;
    let pdf = upload(&s, "pages.pdf", "application/pdf", PDF).await?;
    let other = upload(&s, "other.txt", "text/plain", b"OTHER-MARKER").await?;
    let big_path = file_path(&s, &big);
    let binary_path = file_path(&s, &binary);
    let other_path = file_path(&s, &other);
    let pdf_text = format!("{}.txt", file_path(&s, &pdf).display());
    let prompt = "Read this turn's attached files.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![json!([
            call(
                "tail",
                "read_file",
                &json!({"requests":[{"path":big_path,"start_line":59_999,"max_bytes":100}]})
            ),
            call(
                "binary",
                "read_file",
                &json!({"requests":[{"path":binary_path}]})
            ),
            call("pdf", "read_file", &json!({"requests":[{"path":pdf_text}]}))
        ])],
    );
    let id = send(&s, prompt, &[big.clone(), binary.clone(), pdf]).await?;
    delivered(&s, "general", &id).await?;
    assert_counts(&s, &id, 0, 0)?;
    let feedback = outputs(&s, "general", &id, &script, prompt)
        .await?
        .join("\n");
    for marker in ["TAIL-MARKER", "binary_file_not_supported", "Beta PDF"] {
        assert!(feedback.contains(marker), "missing {marker}: {feedback}");
    }
    let text = input_text(&script.requests.lock().unwrap()[0]);
    assert!(text.contains("### Attachment Not Inlined: big.log"));
    assert!(text.contains("larger than the 512000-byte inline limit"));
    for (prompt, calls, attachments, count) in [
        (
            "Read the unattached file.",
            vec![
                call(
                    "direct",
                    "read_file",
                    &json!({"requests":[{"path":other_path}]}),
                ),
                call(
                    "traversal",
                    "read_file",
                    &json!({"requests":[{"path":format!("{}/../{}", binary_path.display(), other["file_id"].as_str().unwrap())}]}),
                ),
            ],
            vec![binary.clone()],
            2,
        ),
        (
            "Count the attached bytes with a command.",
            vec![call(
                "wc",
                "run_command",
                &json!({"command":format!("wc -c '{}'",binary_path.display()),"summary":"Count bytes","state_effect":"read_only"}),
            )],
            vec![binary],
            1,
        ),
        (
            "Read a prior turn's file.",
            vec![call(
                "old",
                "read_file",
                &json!({"requests":[{"path":big_path}]}),
            )],
            vec![],
            1,
        ),
    ] {
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.into(), vec![json!(calls)]);
        let id = send(&s, prompt, &attachments).await?;
        let turn =
            s.gw.wait_turn(
                "general",
                &id,
                &["waiting_for_form", "delivered", "failed"],
                Duration::from_secs(20),
            )
            .await?;
        assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
        assert_counts(&s, &id, count, count)?;
        approve(&s, "general", "deny").await?;
        delivered(&s, "general", &id).await?;
        assert_counts(&s, &id, count, 0)?;
        assert!(
            !outputs(&s, "general", &id, &script, prompt)
                .await?
                .join("\n")
                .contains("OTHER-MARKER")
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
