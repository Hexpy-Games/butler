// test-category: security
//! Unresolvable command scopes require fresh, exact unsandboxed consent.
use super::stub::{self, Script, call};
use super::{approve, delivered, outputs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};

const SECRET: &str = "scope-secret-marker";
const REASON: &str = "authority.unsandboxedReason";

struct Form {
    name: &'static str,
    command: String,
    cwd: String,
    protected: bool,
}

fn forms(data: &Path, home: &Path) -> Vec<Form> {
    let d = data.display();
    let h = home.display();
    [
        (
            "cd",
            format!("cd '{d}' && cat auth/probe.txt"),
            false,
            false,
        ),
        (
            "shell-text",
            format!("bash -c \"cd {d} && cat auth/probe.txt\""),
            false,
            false,
        ),
        ("escape", format!(r"cat {d}/au\th/probe.txt"), false, false),
        ("split", format!("cat \"{d}\"/auth/probe.txt"), false, false),
        (
            "concat",
            format!("cat \"{d}\"\"/auth/probe.txt\""),
            false,
            false,
        ),
        (
            "subshell",
            format!("(cd '{d}' && cat auth/probe.txt)"),
            false,
            false,
        ),
        (
            "conditional",
            format!("if true; then cat {d}/auth/probe.txt; fi"),
            false,
            true,
        ),
        (
            "wrapper",
            format!("command cat {d}/auth/probe.txt"),
            false,
            true,
        ),
        ("parent", "cat d/../.aws/credentials".into(), false, false),
        (
            "pipeline",
            format!("cd '{h}/Documents' | true; cat auth/probe.txt"),
            true,
            false,
        ),
        (
            "failed-cd",
            format!("cd '{h}/nonexistent'; cat auth/probe.txt"),
            true,
            false,
        ),
        ("absolute", format!("cat {d}/auth/probe.txt"), false, true),
        ("relative", "cat auth/probe.txt".into(), true, true),
    ]
    .into_iter()
    .map(|(name, command, in_data, protected)| Form {
        protected,
        name,
        command,
        cwd: if in_data { d.to_string() } else { ".".into() },
    })
    .collect()
}

async fn setup(
    access: Access,
) -> Result<(Scenario, String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("UNSANDBOXED-SCOPE")?
        .access(access)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_TEST_SECRET_READ_DENIAL", "unavailable");
    let home = &setup.sandbox.home;
    for path in [
        setup.sandbox.data.join("auth/probe.txt"),
        home.join(".aws/credentials"),
    ] {
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, SECRET)?;
    }
    std::fs::create_dir_all(home.join("Documents"))?;
    let folder = home.join("proj");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::create_dir_all(&project)?;
    butler_platform::secure_fs::symlink(&s.sandbox.home.join("Documents"), &project.join("d"))?;
    Ok((s, chat, script, server))
}

async fn submit(
    s: &Scenario,
    chat: &str,
    script: &Script,
    prompt: &str,
    form: &Form,
    effect: &str,
) -> Result<(String, Value), HarnessError> {
    script.rounds.lock().unwrap().insert(prompt.into(), vec![call(prompt, "run_command",
        &json!({"command":form.command,"cwd":form.cwd,"summary":"Run step","state_effect":effect}))]);
    let turn = s.gw.say_turn(chat, prompt).await?;
    let state =
        s.gw.wait_turn(
            chat,
            &turn,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    Ok((turn, state))
}

fn dispatches(s: &Scenario) -> Result<u64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    Ok(db.query_row(
        "SELECT coalesce(sum(dispatch_attempts),0) FROM btcc_guided_effects",
        [],
        |row| row.get(0),
    )?)
}

async fn matrix(effect: &str) -> Result<(), HarnessError> {
    let (s, chat, script, server) = setup(Access::AskExceptReads).await?;
    for form in forms(&s.sandbox.data, &s.sandbox.home) {
        let before = dispatches(&s)?;
        let prompt = format!("{effect}-{}", form.name);
        let (turn, state) = submit(&s, &chat, &script, &prompt, &form, effect).await?;
        assert_eq!(state["state"], "waiting_for_form", "{}: {state}", form.name);
        assert_eq!(dispatches(&s)?, before, "ran before consent: {}", form.name);
        // No command result has reached the model before the decision.
        assert_eq!(script.requests_for(&prompt).len(), 1);
        let cards = s.gw.approval_requests(&chat).await?;
        assert_eq!(cards.len(), 1, "{cards:?}");
        assert_eq!(cards[0]["approval"]["operation"]["command"], form.command);
        if form.protected {
            // Literal credential paths must still be refused after Allow.
            approve(&s, &chat, "allow").await?;
        } else {
            assert_eq!(cards[0]["reason"], REASON, "{}: {cards:?}", form.name);
            approve(&s, &chat, "deny").await?;
        }
        delivered(&s, &chat, &turn).await?;
        let output = outputs(&s, &chat, &turn, &script, &prompt)
            .await?
            .join("\n");
        assert!(!output.contains(SECRET), "{}: {output}", form.name);
        if form.protected {
            assert!(output.contains("protected_path"), "{}: {output}", form.name);
        } else {
            assert_eq!(dispatches(&s)?, before, "ran after denial: {}", form.name);
        }
        eprintln!("UNSANDBOXED-SCOPE {effect} {}: protected", form.name);
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn mutation_spellings_require_informed_consent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX spellings"
    );
    matrix("mutation").await
}

#[tokio::test]
async fn remote_spellings_require_informed_consent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX spellings"
    );
    matrix("remote_observation").await
}

#[tokio::test]
async fn standing_grants_never_cover_an_unresolved_scope() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX spellings"
    );
    let (s, chat, script, server) = setup(Access::AskExceptReads).await?;
    let project = s.sandbox.home.join("proj/작업 Project");
    for (prompt, command, action) in [
        ("first", "cd . && echo first > first.txt", "allow"),
        ("second", "command cd . && echo second > second.txt", "deny"),
    ] {
        let form = Form {
            protected: false,
            name: prompt,
            command: command.into(),
            cwd: ".".into(),
        };
        let before = dispatches(&s)?;
        let (turn, state) = submit(&s, &chat, &script, prompt, &form, "mutation").await?;
        assert_eq!(dispatches(&s)?, before, "ran before consent");
        assert_eq!(state["state"], "waiting_for_form", "{state}");
        assert!(
            !project.join(format!("{prompt}.txt")).exists(),
            "ran before consent"
        );
        let cards = s.gw.approval_requests(&chat).await?;
        assert_eq!(cards.len(), 1, "{cards:?}");
        assert_eq!(cards[0]["reason"], REASON, "{cards:?}");
        assert_eq!(cards[0]["approval"]["operation"]["command"], command);
        let reference = cards[0]["request_ref"].as_str().unwrap();
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/{action}?session_id={chat}"),
                json!({"scope":"conversation"}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
        delivered(&s, &chat, &turn).await?;
    }
    assert_eq!(
        std::fs::read_to_string(project.join("first.txt"))?.trim(),
        "first"
    );
    assert!(!project.join("second.txt").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn resolved_project_commands_keep_plain_behavior() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, chat, script, server) = setup(Access::AskExceptReads).await?;
    let project = s.sandbox.home.join("proj/작업 Project");
    std::fs::write(project.join("notes.txt"), "ordinary-note")?;
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&project)
            .status()?
            .success()
    );
    for (command, effect) in [
        ("cat notes.txt", "read_only"),
        ("ls", "read_only"),
        ("git status", "mutation"),
        ("echo hi > out.txt", "mutation"),
    ] {
        let form = Form {
            protected: false,
            name: "control",
            command: command.into(),
            cwd: ".".into(),
        };
        let (turn, state) = submit(&s, &chat, &script, command, &form, effect).await?;
        if state["state"] == "waiting_for_form" {
            let cards = s.gw.approval_requests(&chat).await?;
            assert_eq!(cards.len(), 1, "{cards:?}");
            assert_ne!(cards[0]["reason"], REASON, "{cards:?}");
            approve(&s, &chat, "allow").await?;
        }
        delivered(&s, &chat, &turn).await?;
        let output = outputs(&s, &chat, &turn, &script, command)
            .await?
            .join("\n");
        if command == "cat notes.txt" {
            assert!(output.contains("ordinary-note"), "{output}");
        }
        let values: Vec<Value> = outputs(&s, &chat, &turn, &script, command)
            .await?
            .iter()
            .map(|raw| serde_json::from_str(raw).unwrap())
            .collect();
        assert_eq!(values.len(), 1);
        let body = values[0]
            .get("output")
            .filter(|v| v.is_object())
            .unwrap_or(&values[0]);
        assert_eq!(body["exit_code"], 0, "{body}");
        assert!(!output.contains("protected_path"), "{output}");
    }
    assert_eq!(
        std::fs::read_to_string(project.join("out.txt"))?.trim(),
        "hi"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn full_access_keeps_non_butler_inventory_reads() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, chat, script, server) = setup(Access::FullAccess).await?;
    let path = s.sandbox.home.join(".aws/config");
    std::fs::write(&path, "ordinary-cloud-config")?;
    let form = Form {
        protected: false,
        name: "full-access",
        command: format!("cat '{}'", path.display()),
        cwd: ".".into(),
    };
    for effect in ["read_only", "mutation"] {
        let (turn, state) = submit(&s, &chat, &script, effect, &form, effect).await?;
        assert_eq!(state["state"], "delivered", "{state}");
        assert_eq!(s.gw.approval_requests(&chat).await?.len(), 0);
        let output = outputs(&s, &chat, &turn, &script, effect).await?.join("\n");
        assert!(!output.contains("protected_path"), "{output}");
        assert!(output.contains("ordinary-cloud-config"), "{output}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
