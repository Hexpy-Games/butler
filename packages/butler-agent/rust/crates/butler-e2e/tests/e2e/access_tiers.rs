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
    let folder = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(&folder)?;
    let outside = setup.sandbox.home.join("outside.txt");
    std::fs::write(&outside, "outside-marker")?;
    std::fs::write(setup.sandbox.data.join("x.txt"), "data-marker")?;
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &folder).await?;
    // bind_project creates this child under the selected parent, as in PROJECT-WORKSPACE.
    let project = folder.join("작업 Project");
    std::fs::create_dir_all(project.join(".git"))?;
    std::fs::write(project.join("a.txt"), "project-marker")?;
    std::fs::write(project.join(".env"), "KEY=SECRET_IN_ENV")?;
    std::fs::write(project.join(".git/config"), "KEY=SECRET_IN_GIT")?;
    std::fs::write(project.join("id_rsa"), "SECRET_IN_KEY")?;
    std::fs::write(project.join("public-key.txt"), "KEY=PUBLIC_KEY")?;
    let linked = if butler_platform::command_sandbox::POSIX_SHELL {
        butler_platform::secure_fs::symlink(&outside, &project.join("link"))?;
        butler_platform::secure_fs::symlink(&project.join(".env"), &project.join("env-link"))?;
        true
    } else {
        false
    };
    let mut batch = vec![
        read("inside", "a.txt"),
        call("list", "list_files", &json!({"root":"."})),
        read(
            "alias",
            &butler_platform::secure_fs::workspace_test_alias(&project.join("a.txt"))
                .to_string_lossy(),
        ),
        read("outside", &outside.to_string_lossy()),
        call(
            "grep",
            "grep_files",
            &json!({"root":".","pattern":"SECRET_IN_ENV","literal":true}),
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
    assert_eq!(script.requests_for(MIXED).len(), 1);
    assert_counts(&s, &id, expected as u64, expected as u64)?;
    approve(&s, &chat, "allow").await?;
    delivered(&s, &chat, &id).await?;
    assert_counts(&s, &id, expected as u64, 0)?;
    assert_eq!(
        script.requests_for(MIXED).len(),
        2,
        "resuming must not reissue a model round"
    );
    let output = outputs(&s, &chat, &id, &script, MIXED).await?;
    assert_eq!(output.len(), 5 + usize::from(linked));
    for raw in &output {
        let value: Value = serde_json::from_str(raw)?;
        let body = value
            .get("output")
            .filter(|v| v.is_object())
            .unwrap_or(&value);
        assert_eq!(body["ok"], true, "{body}");
        if let Some(matches) = body.get("matches").and_then(Value::as_array) {
            assert!(matches.is_empty(), "secret traversal: {body}");
        } else {
            assert!(!raw.contains("SECRET_IN_ENV") && !raw.contains("SECRET_IN_GIT"));
        }
    }
    assert_eq!(
        output
            .iter()
            .filter(|v| v.contains("project-marker"))
            .count(),
        2
    );
    assert_eq!(
        output
            .iter()
            .filter(|v| v.contains("outside-marker"))
            .count(),
        expected
    );
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
                &json!({"command":"pwd","summary":"Check directory","state_effect":"read_only"}),
            ),
            call(
                "write",
                "write_file",
                &json!({"path":"b.txt","content":"written-marker"}),
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
    let write_outputs = outputs(&s, &chat, &id, &script, WRITE).await?;
    let write_requests = script.requests_for(WRITE).len();
    assert_eq!(write_outputs.len(), 2);
    for raw in &write_outputs {
        let value: Value = serde_json::from_str(raw)?;
        let body = value
            .get("output")
            .filter(|v| v.is_object())
            .unwrap_or(&value);
        assert_eq!(body["ok"], true, "{body}");
    }
    assert_eq!(write_requests, 3);
    eprintln!(
        "PERM-01 write: elapsed_ms={} authority_count=1 pending=0 tool_count={} model_requests={write_requests}",
        write_started.elapsed().as_millis(),
        write_outputs.len()
    );
    guarded_reads(&s, &chat, &script, linked).await?;
    guarded_commands(&s, &chat, &script, &project, linked).await?;
    for (prompt, args) in [
        (
            "Check outside command.",
            json!({"command":format!("cat {}", outside.display()),"summary":"Read marker","state_effect":"read_only"}),
        ),
        (
            "Check data command.",
            json!({"command":format!("cat {}", s.sandbox.data.join("x.txt").display()),"summary":"Read marker","state_effect":"read_only"}),
        ),
    ] {
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.into(), vec![call("command", "run_command", &args)]);
        let id = paused(&s, &chat, prompt).await?;
        approve(&s, &chat, "allow").await?;
        delivered(&s, &chat, &id).await?;
        assert_counts(&s, &id, 1, 0)?;
        assert!(
            outputs(&s, &chat, &id, &script, prompt)
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
            &json!({"command":"ls","summary":"List files","state_effect":"read_only"}),
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
        &json!({"requests":[{"path":path,"max_bytes":2048}]}),
    )
}
async fn paused(s: &Scenario, chat: &str, prompt: &str) -> Result<String, HarnessError> {
    let id = accepted_turn_id(&s.gw.say(chat, prompt).await?)?;
    let turn =
        s.gw.wait_turn(
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
async fn outputs(
    s: &Scenario,
    chat: &str,
    id: &str,
    script: &Arc<Script>,
    prompt: &str,
) -> Result<Vec<String>, HarnessError> {
    let rows = tool_rows(&s.gw.messages(chat).await?, id);
    let requests = script.requests_for(prompt);
    let inputs = requests
        .last()
        .and_then(|request| request["input"].as_array())
        .unwrap();
    let mut output = Vec::new();
    for row in rows {
        let raw = inputs
            .iter()
            .rev()
            .find(|item| {
                item["type"] == "function_call_output" && item["call_id"] == row["tool_call_id"]
            })
            .and_then(|item| item["output"].as_str())
            .ok_or_else(|| {
                HarnessError(format!(
                    "Missing delivered feedback for {}",
                    row["tool_call_id"]
                ))
            })?;
        assert!(!raw.contains("authority_pending"));
        let value: Value = serde_json::from_str(raw)?;
        let body = value
            .get("output")
            .filter(|v| v.is_object())
            .unwrap_or(&value);
        // Failed operations have model feedback but no output artifact (PROJECT-WORKSPACE).
        // Successful results must also remain readable through the public inspector.
        if body["ok"] == true {
            let evidence = s.gw.operation_output(id, &row).await?;
            assert!(!evidence.contains("authority_pending"));
        }
        output.push(raw.to_owned());
    }
    Ok(output)
}
async fn guarded_reads(
    s: &Scenario,
    chat: &str,
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
            !outputs(s, chat, &id, script, &prompt)
                .await?
                .iter()
                .any(|v| v.contains("SECRET_IN_ENV"))
        );
    }
    if linked {
        eprintln!("PERM-01 A1: secret_symlink=asked denied authority_count=1 pending=0");
    }
    Ok(())
}
async fn schedule_clamp(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
) -> Result<(), HarnessError> {
    let created =
        s.gw.post(
            "/automations",
            json!({
                "title":"Guarded", "prompt_body":"Check", "target_session_id":chat,
                "interval_seconds":3600, "access_mode":"ask_first"
            }),
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let schedule_id = created.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let prompt = "Raise the schedule to full access.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![
            call(
                "describe",
                "tool_describe",
                &json!({"ids":["native:update_automation"]}),
            ),
            call(
                "schedule",
                "tool_call",
                &json!({"id":"native:update_automation","arguments":{
                    "id":schedule_id,"access_mode":"full_access"
                }}),
            ),
        ],
    );
    let id = accepted_turn_id(&s.gw.say(chat, prompt).await?)?;
    delivered(s, chat, &id).await?;
    assert_counts(s, &id, 0, 0)?;
    assert!(
        outputs(s, chat, &id, script, prompt)
            .await?
            .iter()
            .any(|v| v.contains("schedule_access_exceeds_turn"))
    );
    let stored = s.gw.get(&format!("/automations/{schedule_id}")).await?;
    assert_eq!(stored.status, 200, "{stored:?}");
    assert_eq!(stored.data()["automation"]["access_mode"], "ask_first");
    eprintln!("PERM-01 D6: update=refused access_mode=ask_first authority_count=0 pending=0");
    Ok(())
}

async fn guarded_commands(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    project: &std::path::Path,
    linked: bool,
) -> Result<(), HarnessError> {
    for command in [
        "cat link",
        "cat id_rsa",
        "cat {..,a}/outside.txt",
        "cd && cat .zsh_history",
        "cat .en?",
    ] {
        if command == "cat link" && !linked {
            continue;
        }
        let prompt = format!("Guard command {command}.");
        script.rounds.lock().unwrap().insert(
            prompt.clone(),
            vec![call(
                "guard",
                "run_command",
                &json!({"command":command,"summary":"Read files","state_effect":"read_only"}),
            )],
        );
        let id = paused(s, chat, &prompt).await?;
        assert_counts(s, &id, 1, 1)?;
        approve(s, chat, "deny").await?;
        delivered(s, chat, &id).await?;
        assert_counts(s, &id, 1, 0)?;
        let output = outputs(s, chat, &id, script, &prompt).await?;
        assert!(
            output
                .iter()
                .all(|v| !v.contains("SECRET_IN_") && !v.contains("outside-marker"))
        );
    }
    if butler_platform::command_sandbox::READ_ONLY_SANDBOX {
        let prompt = "Search project keys.";
        script.rounds.lock().unwrap().insert(prompt.into(), vec![call("grep-command", "run_command",
            &json!({"command":"grep -r KEY .","summary":"Search keys","state_effect":"read_only"}))]);
        let id = accepted_turn_id(&s.gw.say(chat, prompt).await?)?;
        delivered(s, chat, &id).await?;
        assert_counts(s, &id, 0, 0)?;
        let output = outputs(s, chat, &id, script, prompt).await?;
        assert_eq!(output.len(), 1);
        assert!(
            output.iter().any(|v| v.contains("PUBLIC_KEY")),
            "{output:?}"
        );
        assert!(
            output.iter().all(|v| !v.contains("SECRET_IN_")),
            "{output:?}"
        );
        // An exact approval grants the read, never writes or network access.
        let prompt = "Approve an outside observation with a write attempt.";
        let outside = s.sandbox.home.join("outside.txt");
        let marker = project.join("approval-write.txt");
        let command = format!(
            "cat '{}' ; printf changed > '{}'",
            outside.display(),
            marker.display()
        );
        script.rounds.lock().unwrap().insert(
            prompt.into(),
            vec![call(
                "approved-command",
                "run_command",
                &json!({"command":command,"summary":"Read marker","state_effect":"read_only"}),
            )],
        );
        let id = paused(s, chat, prompt).await?;
        approve(s, chat, "allow").await?;
        delivered(s, chat, &id).await?;
        assert_counts(s, &id, 1, 0)?;
        let output = outputs(s, chat, &id, script, prompt).await?;
        assert!(
            output.iter().any(|v| v.contains("outside-marker")),
            "{output:?}"
        );
        assert!(!marker.exists(), "approval removed the read-only sandbox");
    }
    eprintln!(
        "PERM-01 commands: bare_paths=asked expansions=asked project_secrets=blocked approval_writes=blocked"
    );
    Ok(())
}
