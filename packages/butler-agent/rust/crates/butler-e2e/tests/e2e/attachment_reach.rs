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
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn attachment_reads_skip_approval_only_for_this_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("ATT-REACH-01")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
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
    // Upload IDs are single-use: each later turn gets its own attachment.
    let traversal = upload(&s, "traversal.bin", "application/octet-stream", b"binary\0").await?;
    let traversal_path = file_path(&s, &traversal);
    let listed = upload(&s, "listed.bin", "application/octet-stream", b"listed\0").await?;
    let mixed = upload(&s, "mixed.bin", "application/octet-stream", b"mixed\0").await?;
    let mixed_path = file_path(&s, &mixed);
    let command = upload(&s, "command.bin", "application/octet-stream", b"command\0").await?;
    let command_path = file_path(&s, &command);
    let outside = s.sandbox.home.join("outside.txt");
    std::fs::write(&outside, "OTHER-MARKER")?;
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
                    &json!({"requests":[{"path":format!("{}/../{}", traversal_path.display(), other["file_id"].as_str().unwrap())}]}),
                ),
            ],
            vec![traversal],
            2,
        ),
        (
            "Inspect the attachment directory.",
            vec![
                call(
                    "list",
                    "list_files",
                    &json!({"root":big_path.parent().unwrap()}),
                ),
                call(
                    "grep",
                    "grep_files",
                    &json!({"root":big_path.parent().unwrap(),"pattern":"OTHER-MARKER","literal":true}),
                ),
            ],
            vec![listed],
            2,
        ),
        (
            "Read attached and unattached files together.",
            vec![call(
                "mixed",
                "read_file",
                &json!({"requests":[{"path":mixed_path},{"path":outside}]}),
            )],
            vec![mixed],
            1,
        ),
        (
            "Count the attached bytes with a command.",
            vec![call(
                "wc",
                "run_command",
                &json!({"command":format!("wc -c '{}'",command_path.display()),"summary":"Count bytes","state_effect":"read_only"}),
            )],
            vec![command],
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

async fn send_to(
    s: &Scenario,
    chat: &str,
    prompt: &str,
    files: &[Value],
    mode: Access,
) -> Result<String, HarnessError> {
    let reply = s.gw.post("/messages", json!({
        "chat_id":chat,"text":prompt,"access_mode":mode.as_str(),
        "attachments":files.iter().map(|file| json!({"file_id":file["file_id"]})).collect::<Vec<_>>(),
        "client_message_id":uuid::Uuid::new_v4().to_string(),
    })).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    s.gw.accepted_turn(reply.data()).await
}

async fn pending(s: &Scenario, chat: &str, id: &str) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_turn(
            chat,
            id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    assert_counts(s, id, 1, 1)
}

async fn project_attachment(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    let uploaded =
        s.gw.upload(
            "attached.log",
            "text/plain",
            b"PROJECT-ATTACHMENT-MARKER",
            Some(chat),
        )
        .await?;
    assert_eq!(uploaded.status, 201, "{}", uploaded.text);
    Ok(uploaded.data()["file"].clone())
}

#[tokio::test]
async fn attachment_reads_in_project_respect_access_modes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("ATT-REACH-02")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    assert!(!folder.starts_with(&setup.sandbox.data));
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &folder).await?;
    for mode in [Access::AskExceptReads, Access::Auto, Access::AskAlways] {
        let file = project_attachment(&s, &chat).await?;
        let path = file_path(&s, &file);
        let prompt = format!("Read the project attachment in {} mode.", mode.as_str());
        let mut calls = vec![call(
            "read",
            "read_file",
            &json!({"requests":[{"path":path}]}),
        )];
        let linked =
            matches!(mode, Access::AskExceptReads) && butler_platform::command_sandbox::POSIX_SHELL;
        if linked {
            let link = folder.join("작업 Project/attachment-link");
            butler_platform::secure_fs::symlink(&path, &link)?;
            calls.push(call(
                "link",
                "read_file",
                &json!({"requests":[{"path":link}]}),
            ));
        }
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.clone(), vec![json!(calls)]);
        let id = send_to(&s, &chat, &prompt, std::slice::from_ref(&file), mode).await?;
        let asks = linked || matches!(mode, Access::AskAlways);
        if asks {
            pending(&s, &chat, &id).await?;
            approve(&s, &chat, if linked { "deny" } else { "allow" }).await?;
        }
        delivered(&s, &chat, &id).await?;
        assert_counts(&s, &id, u64::from(asks), 0)?;
        let results = outputs(&s, &chat, &id, &script, &prompt).await?;
        assert_eq!(results.len(), 1 + usize::from(linked));
        if linked {
            assert_eq!(
                results
                    .iter()
                    .filter(|raw| raw.contains("PROJECT-ATTACHMENT-MARKER"))
                    .count(),
                1,
                "only the direct stored path may read without approval: {results:?}"
            );
        }
        let output = results.join("\n");
        assert!(output.contains("PROJECT-ATTACHMENT-MARKER"), "{output}");
    }
    // A project file mixed with an attachment must not inherit the latter's
    // uncontained execution. Nor may an attachment be read from another chat.
    let file = project_attachment(&s, &chat).await?;
    let path = file_path(&s, &file);
    let project_file = folder.join("작업 Project/ordinary.txt");
    std::fs::write(&project_file, "PROJECT-FILE-MARKER")?;
    for (chat, prompt, paths, files) in [
        (
            chat.as_str(),
            "Read a mixed project batch.",
            vec![path.clone(), project_file],
            vec![file],
        ),
        (
            "general",
            "Read another session's attachment.",
            vec![path],
            vec![],
        ),
    ] {
        script.rounds.lock().unwrap().insert(prompt.into(), vec![json!([
            call("read", "read_file", &json!({"requests":paths.iter().map(|path| json!({"path":path})).collect::<Vec<_>>()})),
        ])]);
        let id = send_to(&s, chat, prompt, &files, Access::AskExceptReads).await?;
        pending(&s, chat, &id).await?;
        approve(&s, chat, "deny").await?;
        delivered(&s, chat, &id).await?;
        assert_counts(&s, &id, 1, 0)?;
        let output = outputs(&s, chat, &id, &script, prompt).await?.join("\n");
        assert!(!output.contains("PROJECT-ATTACHMENT-MARKER"), "{output}");
        assert!(!output.contains("PROJECT-FILE-MARKER"), "{output}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
