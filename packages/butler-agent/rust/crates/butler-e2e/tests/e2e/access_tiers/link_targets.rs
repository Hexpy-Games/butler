//! PERM-LINK: a path whose link leads somewhere other than its spelling asks
//! with the real place (absolute, native separators), for list roots,
//! command folders, absolute in-folder paths and paths outside the folder;
//! an approval covers only the place it showed, so a link retargeted before
//! the approval refuses the operation.
use super::stub::{self, Script, call};
use super::{approve, delivered, outputs, paused};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use butler_platform::secure_fs::{canonicalize, fixture_links::directory_alias};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

const RETARGET: &str = "Write the moved note.";

#[tokio::test]
async fn link_targets_ask_with_the_real_place_and_bind_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-LINK")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    let home = setup.sandbox.home.clone();
    let folder = home.join("proj");
    for directory in [&folder, &home.join("linked-a"), &home.join("linked-b")] {
        std::fs::create_dir_all(directory)?;
    }
    std::fs::create_dir_all(home.join("secret"))?;
    std::fs::write(home.join("secret/s.txt"), "secret-marker")?;
    directory_alias(&home.join("secret"), &home.join("notes-link"))?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::create_dir_all(&project)?;
    directory_alias(&home.join("linked-a"), &project.join("out-link"))?;
    let linked = canonicalize(home.join("linked-a"))?;
    let steps = [
        (
            "Search the linked folder.",
            call(
                "grep",
                "grep_files",
                &json!({"root":"out-link","pattern":"x","literal":true}),
            ),
            json!([linked]),
        ),
        (
            "Make a file in the linked folder.",
            call(
                "cwd",
                "run_command",
                &json!({"command":"echo hi > made.txt","cwd":"out-link","summary":"Make","state_effect":"mutation"}),
            ),
            json!(["echo hi > made.txt"]),
        ),
        (
            "Write through the absolute link path.",
            call(
                "absolute",
                "write_file",
                &json!({"path":project.join("out-link").join("abs.txt"),"content":"x"}),
            ),
            json!([linked.join("abs.txt")]),
        ),
        (
            "Read the linked notes.",
            call(
                "outside",
                "read_file",
                &json!({"requests":[{"path":home.join("notes-link").join("s.txt")}]}),
            ),
            json!([canonicalize(home.join("secret"))?.join("s.txt")]),
        ),
    ];
    for (prompt, step, examples) in steps {
        let (id, card) = asked(&s, &chat, &script, prompt, step).await?;
        assert_eq!(card["examples"], examples, "{card}");
        if prompt.starts_with("Make") {
            let target = &card["targets"][0];
            assert_eq!(target["kind"], "outside", "{card}");
            assert_eq!(target["path"], json!(linked), "{card}");
        }
        approve(&s, &chat, "deny").await?;
        delivered(&s, &chat, &id).await?;
    }
    assert!(!linked.join("made.txt").exists() && !linked.join("abs.txt").exists());
    retargeted(&s, &chat, &script, &home, &project).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The turn the step paused and the approval card it raised.
async fn asked(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    prompt: &str,
    step: Value,
) -> Result<(String, Value), HarnessError> {
    script
        .rounds
        .lock()
        .unwrap()
        .insert(prompt.into(), vec![step]);
    let id = paused(s, chat, prompt).await?;
    let cards = s.gw.approval_requests(chat).await?;
    assert_eq!(cards.len(), 1, "{cards:?}");
    Ok((id, cards[0]["approval"].clone()))
}

/// A link retargeted after the card was shown: approving refuses the write
/// rather than writing to the new place.
async fn retargeted(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    home: &Path,
    project: &Path,
) -> Result<(), HarnessError> {
    let step = call(
        "retarget",
        "write_file",
        &json!({"path":"out-link/moved.txt","content":"moved"}),
    );
    let (id, card) = asked(s, chat, script, RETARGET, step).await?;
    let first = canonicalize(home.join("linked-a"))?;
    assert_eq!(card["examples"], json!([first.join("moved.txt")]), "{card}");
    let link = project.join("out-link");
    std::fs::remove_dir(&link).or_else(|_| std::fs::remove_file(&link))?;
    directory_alias(&home.join("linked-b"), &link)?;
    approve(s, chat, "allow").await?;
    delivered(s, chat, &id).await?;
    let output = outputs(s, chat, &id, script, RETARGET).await?;
    assert!(
        output
            .iter()
            .any(|raw| raw.contains("authority_request_identity_mismatch")),
        "{output:?}"
    );
    assert!(!first.join("moved.txt").exists());
    assert!(!home.join("linked-b/moved.txt").exists());
    Ok(())
}
