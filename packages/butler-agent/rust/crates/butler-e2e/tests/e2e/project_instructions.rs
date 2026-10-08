//! Root instruction admission through the real Agent and stub provider.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_e2e::e2e::{
    HarnessError,
    provider::Script,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

async fn project(s: &Scenario, root: &Path) -> Result<String, HarnessError> {
    let secret = fs::read_to_string(
        s.sandbox
            .data
            .join("state/app-gateway/project-folder-token-secret"),
    )?;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
        &json!({"path":root,"expires_at":4_102_444_800_000_u64}),
    )?);
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.trim().as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    let token = format!(
        "v1.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let created = s.gw.post("/projects", json!({"source":"existing_folder","display_name":"Instructions","folder_selection_token":token})).await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let created =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","project_id":id,"workspace_mode":"local"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    Ok(created.data()["session"]["id"].as_str().unwrap().into())
}

fn setup(name: &str) -> Result<Setup, HarnessError> {
    Ok(Setup::new(name)?.synthetic(Script {
        rounds: 0,
        path_for: Box::new(|_| String::new()),
        final_text: "done".into(),
    }))
}

fn prompt(request: &Value) -> String {
    // Decode provider text so multibyte and whitespace fidelity can be asserted.
    let mut text = request["instructions"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    for item in request["input"].as_array().into_iter().flatten() {
        if let Some(content) = item["content"].as_str() {
            text.push_str(content);
        }
        for part in item["content"].as_array().into_iter().flatten() {
            if let Some(content) = part["text"].as_str() {
                text.push_str(content);
            }
        }
    }
    text
}

async fn run(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let before = s.provider()?.requests().len();
    let (_, turn) = s.turn(chat, "Reply done.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), before + 1);
    Ok(prompt(&requests[before]))
}

async fn valid(name: &str, conventional: bool, original: bool) -> Result<(), HarnessError> {
    let setup = setup(name)?;
    let root = setup.sandbox.workspace.clone();
    if conventional {
        fs::write(
            root.join("AGENTS.md"),
            "ROOT_CONVENTION: 사용자의 요청을 따르세요.\n",
        )?;
    }
    if original {
        fs::write(
            root.join("agent.md"),
            "ROOT_ORIGINAL: follow the current user request.\n",
        )?;
    }
    let s = setup.start().await?;
    let chat = project(&s, &root).await?;
    let text = run(&s, &chat).await?;
    assert_eq!(text.contains("ROOT_CONVENTION"), conventional);
    assert_eq!(text.contains("ROOT_ORIGINAL"), original && !conventional);
    assert!(text.contains(if conventional {
        "Loaded AGENTS.md"
    } else {
        "Loaded agent.md"
    }));
    assert_eq!(
        text.contains("AGENTS.md takes precedence; agent.md ignored."),
        conventional && original
    );
    assert!(text.contains("below system and safety rules"));
    s.finish().await
}

#[tokio::test]
async fn original_filename() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    valid("INSTRUCTIONS-original", false, true).await
}
#[tokio::test]
async fn conventional_filename() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    valid("INSTRUCTIONS-conventional", true, false).await
}
#[tokio::test]
async fn conventional_wins() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    valid("INSTRUCTIONS-precedence", true, true).await
}

#[tokio::test]
async fn next_turn_revision_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("INSTRUCTIONS-revision")?;
    let root = setup.sandbox.workspace.clone();
    fs::write(root.join("agent.md"), "REVISION_ONE")?;
    let mut s = setup.start().await?;
    let chat = project(&s, &root).await?;
    assert!(run(&s, &chat).await?.contains("REVISION_ONE"));
    fs::write(root.join("agent.md"), "REVISION_TWO")?;
    let text = run(&s, &chat).await?;
    assert!(text.contains("REVISION_TWO"));
    assert!(!text.contains("REVISION_ONE"));
    fs::remove_file(root.join("agent.md"))?;
    assert!(
        !run(&s, &chat)
            .await?
            .contains("Project Operating Instructions")
    );
    fs::write(root.join("AGENTS.md"), "RENAMED_REVISION")?;
    s.restart().await?;
    assert!(run(&s, &chat).await?.contains("RENAMED_REVISION"));
    s.finish().await
}

#[tokio::test]
async fn invalid_files_reported_without_partial_injection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("INSTRUCTIONS-invalid")?;
    let root = setup.sandbox.workspace.clone();
    let s = setup.start().await?;
    let chat = project(&s, &root).await?;
    for (bytes, diagnostic) in [
        (
            [b"INVALID_SENTINEL".as_slice(), &[255]].concat(),
            "invalid UTF-8",
        ),
        (
            b"OVERSIZE_SENTINEL".repeat(2300),
            "exceeds the 32 KiB limit",
        ),
    ] {
        fs::write(root.join("AGENTS.md"), bytes)?;
        fs::write(root.join("agent.md"), "FORBIDDEN_FALLBACK")?;
        let text = run(&s, &chat).await?;
        assert!(text.contains(diagnostic));
        for marker in [
            "INVALID_SENTINEL",
            "OVERSIZE_SENTINEL",
            "FORBIDDEN_FALLBACK",
        ] {
            assert!(!text.contains(marker), "unexpected {marker}: {text}");
        }
    }
    s.finish().await
}

#[tokio::test]
async fn root_only_exact_names_and_symlink_rejection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("INSTRUCTIONS-boundary")?;
    let root = setup.sandbox.workspace.clone();
    fs::write(setup.sandbox.root.join("AGENTS.md"), "PARENT_SENTINEL")?;
    fs::write(setup.sandbox.home.join("agent.md"), "HOME_SENTINEL")?;
    fs::write(root.join("Agents.md"), "CASE_SENTINEL")?;
    fs::create_dir(root.join("child"))?;
    fs::write(root.join("child/AGENTS.md"), "CHILD_SENTINEL")?;
    let s = setup.start().await?;
    let chat = project(&s, &root).await?;
    let text = run(&s, &chat).await?;
    for marker in [
        "PARENT_SENTINEL",
        "HOME_SENTINEL",
        "CASE_SENTINEL",
        "CHILD_SENTINEL",
        "Project Operating Instructions",
    ] {
        assert!(!text.contains(marker));
    }
    // The spelling probe aliases AGENTS.md on a case-insensitive filesystem.
    // Finish that scenario before creating the separate symlink fixture.
    fs::remove_file(root.join("Agents.md"))?;
    butler_platform::secure_fs::symlink(
        &s.sandbox.root.join("AGENTS.md"),
        &root.join("AGENTS.md"),
    )?;
    let text = run(&s, &chat).await?;
    assert!(text.contains("symlink"));
    assert!(!text.contains("PARENT_SENTINEL"));
    fs::remove_file(root.join("AGENTS.md"))?;
    fs::write(root.join("agent.md"), "FIRST_PROJECT_ONLY")?;
    let sibling = s.sandbox.root.join("sibling");
    fs::create_dir(&sibling)?;
    fs::write(sibling.join("agent.md"), "SECOND_PROJECT_ONLY")?;
    let other = project(&s, &sibling).await?;
    let text = run(&s, &other).await?;
    assert!(text.contains("SECOND_PROJECT_ONLY"));
    assert!(!text.contains("FIRST_PROJECT_ONLY"));
    let text = run(&s, &chat).await?;
    assert!(text.contains("FIRST_PROJECT_ONLY"));
    assert!(!text.contains("SECOND_PROJECT_ONLY"));
    s.finish().await
}

#[tokio::test]
async fn complete_size_cap_snapshot() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("INSTRUCTIONS-cap")?;
    let root = setup.sandbox.workspace.clone();
    let content = format!("{}CAP_END", "x".repeat(32 * 1024 - 7));
    fs::write(root.join("AGENTS.md"), &content)?;
    let s = setup.start().await?;
    let chat = project(&s, &root).await?;
    assert!(run(&s, &chat).await?.contains(&content));
    s.finish().await
}

#[tokio::test]
async fn in_flight_edit_waits_for_next_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("INSTRUCTIONS-in-flight")?;
    let root = setup.sandbox.workspace.clone();
    fs::write(root.join("agent.md"), "IN_FLIGHT_OLD")?;
    fs::write(root.join("notes.txt"), "tool output")?;
    let tool_path = root.join("notes.txt").display().to_string();
    let s = setup
        .synthetic(Script {
            rounds: 1,
            path_for: Box::new(move |_| tool_path.clone()),
            final_text: "done".into(),
        })
        .start()
        .await?;
    let chat = project(&s, &root).await?;
    let gate = s.provider()?.hold_next_reply("Read notes and reply done.");
    let id = accepted_turn_id(&s.gw.say(&chat, "Read notes and reply done.").await?)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while s.provider()?.requests().is_empty() {
        assert!(Instant::now() < deadline, "no admitted request");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    fs::write(root.join("agent.md"), "IN_FLIGHT_NEW_CONTENT")?;
    gate.release();
    let turn =
        s.gw.wait_terminal(&chat, &id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 2);
    for request in requests {
        let text = prompt(&request);
        assert!(text.contains("IN_FLIGHT_OLD"));
        assert!(!text.contains("IN_FLIGHT_NEW_CONTENT"));
    }
    assert!(run(&s, &chat).await?.contains("IN_FLIGHT_NEW_CONTENT"));
    s.finish().await
}
