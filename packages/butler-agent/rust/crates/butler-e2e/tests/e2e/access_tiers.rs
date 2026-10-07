//! PERM-01: project reads, exact approvals, real-path sensitivity and normal-chat isolation.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::{tool_rows, turn_state},
    scenario::{Access, Scenario, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use stub::{Script, call};

const MIXED: &str = "Check project files and outside files.";
const WRITE: &str = "Check the current directory and write b.txt.";
const NORMAL: &str = "Read the data marker.";

#[tokio::test]
async fn ask_first_reads_the_project_and_asks_for_the_rest() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let started = Instant::now();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-01")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    let project = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(project.join(".git"))?;
    std::fs::write(project.join("a.txt"), "project-marker")?;
    std::fs::write(project.join(".env"), "SECRET_IN_ENV")?;
    std::fs::write(project.join(".git/config"), "SECRET_IN_GIT")?;
    let outside = setup.sandbox.home.join("outside.txt");
    std::fs::write(&outside, "outside-marker")?;
    std::fs::write(setup.sandbox.data.join("x.txt"), "data-marker")?;
    let linked = if butler_platform::command_sandbox::POSIX_SHELL {
        butler_platform::secure_fs::symlink(&outside, &project.join("link"))?;
        butler_platform::secure_fs::symlink(&project.join(".env"), &project.join("env-link"))?;
        true
    } else {
        false
    };
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &project).await?;
    let mut batch = vec![
        read("inside", "a.txt"),
        call("list", "list_files", json!({"root":"."})),
        read(
            "alias",
            &butler_platform::secure_fs::workspace_test_alias(&project.join("a.txt"))
                .to_string_lossy(),
        ),
        read("outside", &outside.to_string_lossy()),
        call(
            "grep",
            "grep_files",
            json!({"root":".","pattern":"SECRET_IN_ENV"}),
        ),
    ];
    if linked {
        batch.push(read("escape", "link"));
    }
    script
        .rounds
        .lock()
        .unwrap()
        .insert(MIXED.into(), vec![json!(batch)]);
    let mixed_started = Instant::now();
    let id = paused(&s, &chat, MIXED).await?;
    let expected = if linked { 2 } else { 1 };
    assert_eq!(s.gw.approval_requests(&chat).await?.len(), expected);
    assert_eq!(script.requests.lock().unwrap().len(), 1);
    assert_counts(&s, &id, expected as u64, expected as u64)?;
    approve(&s, &chat, "allow").await?;
    delivered(&s, &chat, &id).await?;
    assert_counts(&s, &id, expected as u64, 0)?;
    assert_eq!(
        script.requests.lock().unwrap().len(),
        2,
        "resuming must not reissue a model round"
    );
    let output = outputs(&s, &chat, &id).await?;
    assert_eq!(output.len(), 5 + usize::from(linked));
    assert!(
        !output
            .iter()
            .any(|v| v.contains("SECRET_IN_ENV") || v.contains("SECRET_IN_GIT"))
    );
    assert!(output.iter().any(|v| v.contains("project-marker")));
    assert!(output.iter().any(|v| v.contains("outside-marker")));
    eprintln!(
        "PERM-01 mixed: elapsed_ms={} authority_count={expected} pending=0 tool_count={} model_requests=2",
        mixed_started.elapsed().as_millis(),
        output.len()
    );
    script.rounds.lock().unwrap().insert(
        WRITE.into(),
        vec![
            call(
                "pwd",
                "run_command",
                json!({"command":"pwd","state_effect":"read_only"}),
            ),
            call(
                "write",
                "write_file",
                json!({"path":"b.txt","content":"written-marker"}),
            ),
        ],
    );
    let write_started = Instant::now();
    let id = paused(&s, &chat, WRITE).await?;
    assert_eq!(s.gw.approval_requests(&chat).await?.len(), 1);
    assert_counts(&s, &id, 1, 1)?;
    approve(&s, &chat, "allow").await?;
    delivered(&s, &chat, &id).await?;
    assert_eq!(
        std::fs::read_to_string(project.join("b.txt"))?,
        "written-marker"
    );
    assert_counts(&s, &id, 1, 0)?;
    eprintln!(
        "PERM-01 write: elapsed_ms={} authority_count=1 pending=0 tool_count=2 model_requests=3",
        write_started.elapsed().as_millis()
    );
    guarded_reads(&s, &chat, &project, &script, linked).await?;
    for (prompt, args) in [
        (
            "Check outside command.",
            json!({"command":format!("cat {}", outside.display()),"state_effect":"read_only"}),
        ),
        (
            "Check data command.",
            json!({"command":format!("cat {}", s.sandbox.data.join("x.txt").display()),"state_effect":"read_only"}),
        ),
    ] {
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.into(), vec![call("command", "run_command", args)]);
        let id = paused(&s, &chat, prompt).await?;
        approve(&s, &chat, "allow").await?;
        delivered(&s, &chat, &id).await?;
        assert_counts(&s, &id, 1, 0)?;
        assert!(
            outputs(&s, &chat, &id)
                .await?
                .iter()
                .any(|v| v.contains("marker"))
        );
    }
    script.rounds.lock().unwrap().insert(
        NORMAL.into(),
        vec![read(
            "data",
            &s.sandbox.data.join("x.txt").to_string_lossy(),
        )],
    );
    let id = paused(&s, "general", NORMAL).await?;
    assert_counts(&s, &id, 1, 1)?;
    approve(&s, "general", "allow").await?;
    delivered(&s, "general", &id).await?;
    assert_counts(&s, &id, 1, 0)?;
    script.rounds.lock().unwrap().insert(
        "List general directory.".into(),
        vec![call(
            "ls",
            "run_command",
            json!({"command":"ls","state_effect":"read_only"}),
        )],
    );
    let id = paused(&s, "general", "List general directory.").await?;
    assert_counts(&s, &id, 1, 1)?;
    approve(&s, "general", "allow").await?;
    delivered(&s, "general", &id).await?;
    assert_counts(&s, &id, 1, 0)?;
    schedule_clamp(&s, &chat, &script).await?;
    eprintln!(
        "PERM-01 complete: elapsed_ms={} model_requests={} A1={linked}",
        started.elapsed().as_millis(),
        script.requests.lock().unwrap().len()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
fn read(id: &str, path: &str) -> Value {
    call(
        id,
        "read_file",
        json!({"requests":[{"path":path,"max_bytes":2048}]}),
    )
}
async fn paused(s: &Scenario, chat: &str, prompt: &str) -> Result<String, HarnessError> {
    let id = accepted_turn_id(&s.gw.say(chat, prompt).await?)?;
    let turn =
        s.gw.wait_state(
            chat,
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(
        turn_state(&turn),
        "waiting_for_form",
        "{turn}\n{}",
        s.agent.logs()
    );
    Ok(id)
}
async fn approve(s: &Scenario, chat: &str, action: &str) -> Result<(), HarnessError> {
    for card in s.gw.approval_requests(chat).await? {
        let reference = card["request_ref"].as_str().unwrap();
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/{action}?session_id={chat}"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
    }
    Ok(())
}
async fn delivered(s: &Scenario, chat: &str, id: &str) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_terminal(chat, id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    Ok(())
}
fn assert_counts(s: &Scenario, id: &str, total: u64, pending: u64) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let counts: (u64,u64) = db.query_row("SELECT count(*),coalesce(sum(decision='pending'),0) FROM btcc_authority_requests WHERE source_turn_id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?)))?;
    assert_eq!(counts, (total, pending));
    Ok(())
}
async fn outputs(s: &Scenario, chat: &str, id: &str) -> Result<Vec<String>, HarnessError> {
    let rows = tool_rows(&s.gw.messages(chat).await?, id);
    let mut output = Vec::new();
    for row in rows {
        output.push(s.gw.operation_output(id, &row).await?);
    }
    Ok(output)
}
async fn guarded_reads(
    s: &Scenario,
    chat: &str,
    project: &Path,
    script: &Arc<Script>,
    linked: bool,
) -> Result<(), HarnessError> {
    for path in [".env", ".git/config", "env-link"]
        .into_iter()
        .filter(|p| *p != "env-link" || linked)
    {
        let prompt = format!("Check guarded {path}.");
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.clone(), vec![read("guarded", path)]);
        let id = paused(s, chat, &prompt).await?;
        assert_counts(s, &id, 1, 1)?;
        approve(s, chat, "deny").await?;
        delivered(s, chat, &id).await?;
        assert_counts(s, &id, 1, 0)?;
        assert!(
            !outputs(s, chat, &id)
                .await?
                .iter()
                .any(|v| v.contains("SECRET_IN_ENV"))
        );
    }
    if linked {
        // Pin A1's open-time boundary independently of pre-call classification:
        // classify ordinary a.txt, then replace it by an in-project secret link.
        let roots = butler_turn::workspace::ScopeRoots {
            project: Some(project),
            butler_data: &s.sandbox.data,
            protected_ledger_roots: &[],
            installation_root: None,
        };
        assert_eq!(
            butler_turn::workspace::classify_targets(&roots, project, &["a.txt"]),
            butler_turn::btcc::TargetScope::ProjectFolder
        );
        std::fs::remove_file(project.join("a.txt"))?;
        butler_platform::secure_fs::symlink(&project.join(".env"), &project.join("a.txt"))?;
        let files = butler_turn::workspace::WorkspaceFiles::new(1);
        let result = files
            .read_one(butler_turn::workspace::ReadFileInput {
                root: project.into(),
                path: "a.txt".into(),
                path_form: butler_turn::workspace::PathForm::Contained,
                protected_roots: vec![],
                start_line: None,
                limit_lines: None,
                max_bytes: 2048,
                offset_bytes: None,
            })
            .await
            .map_err(|e| HarnessError(e.to_string()))??
            .result;
        files.close().await;
        assert!(
            result.to_string().contains("sensitive_path_blocked"),
            "{result}"
        );
        assert!(!result.to_string().contains("SECRET_IN_ENV"));
        eprintln!(
            "PERM-01 A1: swapped_secret_symlink=blocked sensitive_path_blocked; authority_count=1 for preexisting link"
        );
    }
    Ok(())
}
async fn schedule_clamp(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
) -> Result<(), HarnessError> {
    let prompt = "Create a full access schedule.";
    script.rounds.lock().unwrap().insert(prompt.into(), vec![call("schedule", "create_automation", json!({"title":"Guarded","prompt":"Check","schedule_type":"interval","interval_minutes":60,"access_mode":"full_access"}))]);
    let id = accepted_turn_id(&s.gw.say(chat, prompt).await?)?;
    delivered(s, chat, &id).await?;
    assert_counts(s, &id, 0, 0)?;
    assert!(
        outputs(s, chat, &id)
            .await?
            .iter()
            .any(|v| v.contains("schedule_access_exceeds_turn"))
    );
    Ok(())
}
