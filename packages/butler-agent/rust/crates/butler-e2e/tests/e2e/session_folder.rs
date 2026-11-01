//! FOLDER: the agent moves the session's working folder. A command that adds
//! a git worktree moves the session into it; file tools and commands then
//! work there, and the folder survives a restart (FOLDER-01). `switch_folder`
//! into a subfolder runs without asking, while a folder elsewhere asks on
//! 먼저 확인 and becomes consented once approved; full access moves without
//! asking (FOLDER-02). A delegated child starts in the parent's current
//! folder (FOLDER-03).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]

#[path = "session_folder/stub.rs"]
mod stub;

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::{tool_rows, turn_state},
    scenario::{Access, Scenario, Setup},
};
use butler_platform::secure_fs::Canonical as _;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};
use stub::{CHILD, Script, call, command, message, start};

fn git(dir: &Path, args: &[&str]) -> Result<(), HarnessError> {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=Butler Test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .current_dir(dir)
        .status()?;
    assert!(status.success(), "git {args:?}");
    Ok(())
}

fn canonical(path: &Path) -> PathBuf {
    path.canonical().unwrap()
}

fn command_stdout(output: &str) -> String {
    let result: Value = serde_json::from_str(output).unwrap();
    assert_eq!(result["output"]["exit_code"], 0, "{result}");
    result["output"]["stdout"].as_str().unwrap().to_owned()
}

/// The project chat's stored folder and its marker (the scenario's only
/// project session).
fn binding(s: &Scenario) -> Result<(String, Value), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("runtime/session-store.sqlite"))?;
    let (path, metadata): (String, Option<String>) = db.query_row(
        "SELECT workspace_path, metadata_json FROM session_bindings
         WHERE role = 'butler' AND app_project_id IS NOT NULL",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let metadata: Value = serde_json::from_str(&metadata.unwrap_or_else(|| "{}".into()))?;
    Ok((path, metadata["sessionFolder"].clone()))
}

fn authority_count(s: &Scenario, turn: &str) -> Result<u64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    Ok(db.query_row(
        "SELECT count(*) FROM btcc_authority_requests WHERE source_turn_id = ?1",
        [turn],
        |row| row.get(0),
    )?)
}

async fn settle(s: &Scenario, chat: &str, prompt: &str) -> Result<(String, Value), HarnessError> {
    let id = s.gw.say_turn(chat, prompt).await?;
    let turn =
        s.gw.wait_turn(
            chat,
            &id,
            &["waiting_for_form", "delivered", "failed", "cancelled"],
            Duration::from_secs(30),
        )
        .await?;
    Ok((id, turn))
}

async fn delivered(s: &Scenario, chat: &str, prompt: &str) -> Result<String, HarnessError> {
    let (id, turn) = settle(s, chat, prompt).await?;
    if turn_state(&turn) != "delivered" {
        let cards = s.gw.approval_requests(chat).await?;
        panic!("{prompt}: {turn}\napprovals: {cards:?}");
    }
    Ok(id)
}

async fn approve(s: &Scenario, chat: &str) -> Result<Vec<Value>, HarnessError> {
    let cards = s.gw.approval_requests(chat).await?;
    for card in &cards {
        let reference = card["request_ref"].as_str().unwrap();
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/allow?session_id={chat}"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
    }
    Ok(cards)
}

async fn wait_delivered(s: &Scenario, chat: &str, id: &str) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_terminal(chat, id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    Ok(())
}

/// A project chat on 먼저 확인 or full access whose folder is a git repository.
async fn project(
    access: Access,
    id: &str,
) -> Result<
    (
        Scenario,
        String,
        PathBuf,
        Arc<Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = start().await?;
    let setup = Setup::new(id)?
        .access(access)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let parent = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(&parent)?;
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &parent).await?;
    let project = parent.join("작업 Project");
    std::fs::create_dir_all(project.join("sub"))?;
    std::fs::write(project.join("a.txt"), "origin-marker\n")?;
    std::fs::write(project.join("sub/s.txt"), "sub-marker\n")?;
    git(&project, &["init", "-q", "-b", "main"])?;
    // Fixture bytes must not depend on the host's Git checkout policy.
    git(&project, &["config", "core.autocrlf", "false"])?;
    git(&project, &["add", "."])?;
    git(&project, &["commit", "-q", "-m", "init"])?;
    Ok((s, chat, project, script, server))
}

// FOLDER-01
#[tokio::test]
async fn a_new_worktree_becomes_the_working_folder_and_survives_restart() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let started = Instant::now();
    let (mut s, chat, project, script, server) = project(Access::FullAccess, "FOLDER-01").await?;
    let worktree = project.parent().unwrap().join("wt-feature");
    const MAKE: &str = "Make a feature worktree and work in it.";
    script.set(
        MAKE,
        vec![
            command(
                "add",
                "git worktree add ../wt-feature -b feature",
                "mutation",
            ),
            call(
                "write",
                "write_file",
                &json!({"path":"made.txt","content":"made-in-worktree"}),
            ),
            json!([
                call(
                    "read",
                    "read_file",
                    &json!({"requests":[{"path":"made.txt"}]})
                ),
                command("pwd", "pwd", "read_only"),
            ]),
            call(
                "edit",
                "edit_file",
                &json!({"path":"a.txt","old_text":"origin-marker","new_text":"edited-in-worktree"}),
            ),
        ],
    );
    let id = delivered(&s, &chat, MAKE).await?;
    let worktree = canonical(&worktree);
    let outputs = script.outputs(MAKE);
    let added: Value = serde_json::from_str(&outputs["add"])?;
    assert_eq!(
        added["output"]["working_folder_change"]["working_folder"],
        worktree.to_string_lossy().as_ref(),
        "{added}"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("made.txt"))?,
        "made-in-worktree"
    );
    assert!(
        !project.join("made.txt").exists(),
        "write landed in the old folder"
    );
    assert!(
        outputs["read"].contains("made-in-worktree"),
        "{}",
        outputs["read"]
    );
    assert!(
        command_stdout(&outputs["pwd"]).contains(worktree.to_string_lossy().as_ref()),
        "{}",
        outputs["pwd"]
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("a.txt"))?,
        "edited-in-worktree\n"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("a.txt"))?,
        "origin-marker\n"
    );
    let rows = tool_rows(&s.gw.messages(&chat).await?, &id);
    assert!(
        rows.iter()
            .any(|row| row["safe_tool_name"] == "switch_folder"
                && row["safe_input_label"] == worktree.to_string_lossy().as_ref()),
        "no folder activity row: {rows:#?}"
    );
    let session =
        s.gw.get(&format!("/session-summary?session_id={chat}"))
            .await?;
    let branch = &session.data()["branch_info"];
    assert_eq!(branch["workspace_binding"], "session_folder", "{branch}");
    assert_eq!(
        branch["workspace_path"],
        worktree.to_string_lossy().as_ref()
    );
    assert_eq!(branch["branch_name"], "feature");

    s.restart().await?;
    const AFTER: &str = "Where are we working now?";
    script.set(
        AFTER,
        vec![json!([
            command("pwd", "pwd", "read_only"),
            call(
                "read",
                "read_file",
                &json!({"requests":[{"path":"made.txt"}]})
            ),
        ])],
    );
    delivered(&s, &chat, AFTER).await?;
    let outputs = script.outputs(AFTER);
    assert!(
        command_stdout(&outputs["pwd"]).contains(worktree.to_string_lossy().as_ref()),
        "{}",
        outputs["pwd"]
    );
    assert!(
        outputs["read"].contains("made-in-worktree"),
        "{}",
        outputs["read"]
    );
    eprintln!(
        "FOLDER-01: elapsed_ms={} model_requests={}",
        started.elapsed().as_millis(),
        script.requests.lock().unwrap().len()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

// FOLDER-02 (먼저 확인)
#[tokio::test]
async fn a_folder_elsewhere_asks_first_and_is_consented_once_approved() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, chat, project, script, server) = project(Access::AskExceptReads, "FOLDER-02").await?;
    const SUB: &str = "Work in the sub folder.";
    script.set(
        SUB,
        vec![
            call(
                "switch",
                "switch_folder",
                &json!({"path":"sub","reason":"Focus on sub"}),
            ),
            call("read", "read_file", &json!({"requests":[{"path":"s.txt"}]})),
        ],
    );
    let id = delivered(&s, &chat, SUB).await?;
    assert_eq!(authority_count(&s, &id)?, 0, "a subfolder switch asked");
    let sub = canonical(&project.join("sub"));
    assert_eq!(binding(&s)?.0, sub.to_string_lossy());
    assert!(script.outputs(SUB)["read"].contains("sub-marker"));

    let elsewhere = s.sandbox.home.join("elsewhere");
    std::fs::create_dir_all(&elsewhere)?;
    std::fs::write(elsewhere.join("o.txt"), "elsewhere-marker")?;
    let elsewhere = canonical(&elsewhere);
    const OUT: &str = "Work in the other folder.";
    script.set(
        OUT,
        vec![call(
            "switch",
            "switch_folder",
            &json!({"path":elsewhere.to_string_lossy(),"reason":"Other checkout"}),
        )],
    );
    let (id, turn) = settle(&s, &chat, OUT).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    assert_eq!(
        binding(&s)?.0,
        sub.to_string_lossy(),
        "moved before approval"
    );
    let cards = approve(&s, &chat).await?;
    assert_eq!(cards.len(), 1);
    assert_eq!(
        cards[0]["approval"]["action_kind"], "switch_folder",
        "{}",
        cards[0]
    );
    wait_delivered(&s, &chat, &id).await?;
    let (path, marker) = binding(&s)?;
    assert_eq!(path, elsewhere.to_string_lossy());
    assert_eq!(marker["consented"], true, "{marker}");

    // The approved folder counts as the project folder: reads ask nothing.
    const READ: &str = "Read the marker there.";
    script.set(
        READ,
        vec![call(
            "read",
            "read_file",
            &json!({"requests":[{"path":"o.txt"}]}),
        )],
    );
    let id = delivered(&s, &chat, READ).await?;
    assert_eq!(
        authority_count(&s, &id)?,
        0,
        "a read in the approved folder asked"
    );
    assert!(script.outputs(READ)["read"].contains("elsewhere-marker"));

    // Protected folders stay refused.
    const DATA: &str = "Work in Butler's data.";
    script.set(
        DATA,
        vec![call(
            "switch",
            "switch_folder",
            &json!({"path":s.sandbox.data.to_string_lossy(),"reason":"Data"}),
        )],
    );
    let id = delivered(&s, &chat, DATA).await?;
    assert_eq!(authority_count(&s, &id)?, 0);
    assert!(script.outputs(DATA)["switch"].contains("folder_protected"));
    assert_eq!(binding(&s)?.0, elsewhere.to_string_lossy());
    s.finish().await?;
    server.abort();
    Ok(())
}

// FOLDER-02 (full access)
#[tokio::test]
async fn full_access_moves_to_another_folder_without_asking() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, chat, _project, script, server) = project(Access::FullAccess, "FOLDER-02F").await?;
    let elsewhere = s.sandbox.home.join("elsewhere");
    std::fs::create_dir_all(&elsewhere)?;
    let elsewhere = canonical(&elsewhere);
    const OUT: &str = "Work in the other folder.";
    script.set(
        OUT,
        vec![
            call(
                "switch",
                "switch_folder",
                &json!({"path":elsewhere.to_string_lossy(),"reason":"Other checkout"}),
            ),
            command("pwd", "pwd", "read_only"),
        ],
    );
    let id = delivered(&s, &chat, OUT).await?;
    assert_eq!(authority_count(&s, &id)?, 0);
    let (path, marker) = binding(&s)?;
    assert_eq!(path, elsewhere.to_string_lossy());
    // Full access alone is not consent for the folder.
    assert_eq!(marker["consented"], false, "{marker}");
    assert!(
        command_stdout(&script.outputs(OUT)["pwd"]).contains(elsewhere.to_string_lossy().as_ref())
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

// FOLDER-03
#[tokio::test]
async fn a_delegated_child_starts_in_the_parents_current_folder() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = start().await?;
    let s = Setup::new("FOLDER-03")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let work = s.sandbox.home.join("work");
    std::fs::create_dir_all(&work)?;
    let work = canonical(&work);
    const ASK: &str = "Move to the work folder and have a steward check it.";
    script.set(
        ASK,
        vec![
            call(
                "switch",
                "switch_folder",
                &json!({"path":work.to_string_lossy(),"reason":"Work here"}),
            ),
            call(
                "delegate",
                "delegate_to_steward",
                &json!({"request":"Check the working folder.","checks":["Folder checked"],"safe_title":"Folder check"}),
            ),
        ],
    );
    script.set(
        CHILD,
        vec![
            call("child-plan", "replace_work_plan", &json!({"objective":"Check the working folder.","execution_mode":"direct",
                "actions":[{"action_key":"check","description":"Check the folder","dependency_keys":[]}],
                "checks":["Folder checked"]})),
            call("child-review", "record_work_review", &json!({"subject":"plan","verdict":"accept","summary":"Ready"})),
            command("child-pwd", "pwd", "read_only"),
            call("child-done", "record_work_disposition", &json!({"work_id":"{{WORK}}","disposition":"completed",
                "summary":"Checked.","action_updates":[{"action_key":"check","status":"done"}],
                "remaining_actions":[],"followups":[]})),
            message("Checked."),
        ],
    );
    s.turn("general", ASK).await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let child_pwd = loop {
        if let Some(output) = script.outputs(CHILD).remove("child-pwd") {
            break output;
        }
        assert!(
            Instant::now() < deadline,
            "the child never ran pwd\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert!(
        command_stdout(&child_pwd).contains(work.to_string_lossy().as_ref()),
        "{child_pwd}\nparent: {:?}",
        script.outputs(ASK)
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("runtime/session-store.sqlite"))?;
    let child: String = db.query_row(
        "SELECT workspace_path FROM session_bindings WHERE role = 'steward'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(child, work.to_string_lossy());
    s.finish().await?;
    server.abort();
    Ok(())
}
