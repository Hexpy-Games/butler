//! PERM-02: Auto (알아서 진행) asks only for risky actions. In a project chat
//! it edits the project and runs project-contained commands without a card;
//! writes outside the project, `.git`, network and destructive commands
//! outside still ask; the project-write sandbox stops a command that escapes
//! the classifier. A scheduled (unattended) run never waits: the step Auto
//! would ask about fails fast with a reason, and the run is flagged; "run
//! now" is attended and asks as usual.
mod sandbox_setting;
mod unattended;
use unattended::run_where;

use super::stub::{self, Script, call};
use super::{approve, assert_counts, delivered, outputs, paused};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

const EDIT: &str = "Write notes and make a file.";
const ESCAPE: &str = "Run the project build step.";
const SCHEDULED: &str = "Nightly cleanup of the old export.";
const LINKED_WRITE: &str = "Write the note into the linked folder.";

#[tokio::test]
async fn auto_works_in_the_project_and_asks_for_risky_steps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let started = Instant::now();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-02")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(&folder)?;
    let outside = setup.sandbox.home.join("outside.txt");
    std::fs::write(&outside, "outside-marker")?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::create_dir_all(project.join(".git"))?;
    std::fs::write(project.join(".git/config"), "original-config")?;
    std::fs::write(project.join("a.txt"), "project-marker")?;
    std::fs::create_dir_all(project.join("src"))?;
    std::fs::create_dir_all(outside.with_file_name("linked-out"))?;
    butler_platform::secure_fs::fixture_links::directory_alias(
        &outside.with_file_name("linked-out"),
        &project.join("out-link"),
    )?;
    if super::super::windows_sandbox::setup_only() {
        super::super::windows_sandbox::finish_setup(s).await?;
        server.abort();
        return Ok(());
    }
    let contained = butler_platform::command_sandbox::project_write_available();

    sandbox_setting::verify(&s, &chat, &script, &project).await?;

    // In-folder edit and a project-contained command: no card (macOS); the
    // command asks where no project-write sandbox exists.
    script.rounds.lock().unwrap().insert(
        EDIT.into(),
        vec![
            call(
                "notes",
                "write_file",
                &json!({"path":"notes.md","content":"auto-notes"}),
            ),
            mutation("make", "echo hi > src/made.txt"),
            call("read", "read_file", &json!({"requests":[{"path":"a.txt"}]})),
        ],
    );
    let id = s.gw.say_turn(&chat, EDIT).await?;
    if !contained {
        let turn =
            s.gw.wait_turn(&chat, &id, &["waiting_for_form"], Duration::from_secs(20))
                .await?;
        assert_eq!(turn["state"], "waiting_for_form", "{turn}");
        approve(&s, &chat, "allow").await?;
    }
    delivered(&s, &chat, &id).await?;
    let asked = u64::from(!contained);
    assert_counts(&s, &id, asked, 0)?;
    assert_eq!(
        std::fs::read_to_string(project.join("notes.md"))?,
        "auto-notes"
    );
    assert!(project.join("src/made.txt").exists());
    let output = outputs(&s, &chat, &id, &script, EDIT).await?;
    assert!(output.iter().any(|v| v.contains("project-marker")));
    if contained {
        assert!(
            output.iter().any(|v| v.contains("project_write_contained")),
            "{output:?}"
        );
    }
    eprintln!(
        "PERM-02 edit: elapsed_ms={} contained={contained} authority_count={asked}",
        started.elapsed().as_millis()
    );

    if contained {
        sandbox_holds(&s, &chat, &script, &project).await?;
    }
    risky_steps_ask(&s, &chat, &script, &outside).await?;
    external_content_reasks(&mut s, &chat, &script, &outside).await?;
    unattended_schedule(&s, &chat, &script, &outside).await?;
    eprintln!(
        "PERM-02 complete: elapsed_ms={} model_requests={}",
        started.elapsed().as_millis(),
        script.requests.lock().unwrap().len()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn mutation(id: &str, command: &str) -> Value {
    call(
        id,
        "run_command",
        &json!({"command":command,"summary":"Run step","state_effect":"mutation"}),
    )
}

fn done() -> Value {
    json!({"type":"message","id":"msg_done","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":"Checked.","annotations":[]}]})
}

/// A project script's writes are invisible to the classifier (the project
/// edit and the command both run without a card); the sandbox must stop the
/// ones that leave the project or touch `.git`.
async fn sandbox_holds(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    project: &Path,
) -> Result<(), HarnessError> {
    let (path, body, command, publish) = if butler_platform::command_sandbox::POSIX_SHELL {
        (
            "build.sh",
            "echo started > src/sandbox-started.txt\necho escaped > ../escape.txt\necho changed > .git/config\n",
            "sh build.sh",
            "true",
        )
    } else {
        (
            "build.cmd",
            "@echo off\r\necho started>src\\sandbox-started.txt\r\necho escaped>..\\escape.txt\r\necho changed>.git\\config\r\n",
            "cmd /c build.cmd",
            "cmd /c exit 0",
        )
    };
    script.rounds.lock().unwrap().insert(
        ESCAPE.into(),
        vec![
            call("script", "write_file", &json!({"path":path,"content":body})),
            mutation("build", command),
            // Declared outputs must not copy protected files into artifacts
            // that the next contained command can read.
            call(
                "publish",
                "run_command",
                &json!({"command":publish,"summary":"Publish","state_effect":"mutation",
                    "output_paths":[".git/config"]}),
            ),
        ],
    );
    let id = s.gw.say_turn(chat, ESCAPE).await?;
    delivered(s, chat, &id).await?;
    assert_counts(s, &id, 0, 0)?;
    let published = s.sandbox.data.join("artifacts/generated/published");
    assert!(
        !published.exists() || std::fs::read_dir(&published)?.next().is_none(),
        "a protected project file was published"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("src/sandbox-started.txt"))?.trim(),
        "started",
        "project script did not execute"
    );
    let parent = project.parent().unwrap();
    assert!(
        !parent.join("escape.txt").exists(),
        "sandbox let a write escape"
    );
    assert_eq!(
        std::fs::read_to_string(project.join(".git/config"))?,
        "original-config"
    );
    let output = outputs(s, chat, &id, script, ESCAPE).await?;
    assert_eq!(output.len(), 3);
    let command = output
        .iter()
        .find(|raw| raw.contains("project_write"))
        .expect("a project-contained command result");
    assert!(command.contains("sandbox \\\"none\\\""), "{command}");
    eprintln!("PERM-02 sandbox: escape=blocked git_write=blocked authority_count=0");
    Ok(())
}

/// Outside writes, `.git`, destructive commands outside and network ask.
async fn risky_steps_ask(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    outside: &Path,
) -> Result<(), HarnessError> {
    let steps = [
        (
            "Remove the old export.",
            mutation("rm", &format!("rm -f '{}'", outside.display())),
        ),
        (
            "Fix the git config.",
            call(
                "git-config",
                "write_file",
                &json!({"path":".git/config","content":"changed"}),
            ),
        ),
        (
            "Write the outside note.",
            call(
                "outside-write",
                "write_file",
                &json!({"path":outside.with_extension("new").to_string_lossy(),"content":"x"}),
            ),
        ),
        (
            LINKED_WRITE,
            call(
                "linked-write",
                "write_file",
                &json!({"path":"out-link/note.txt","content":"x"}),
            ),
        ),
        (
            "Fetch the release notes.",
            call(
                "net",
                "run_command",
                &json!({"command":"curl -sS https://example.com","summary":"Fetch notes","state_effect":"remote_observation"}),
            ),
        ),
    ];
    for (prompt, step) in steps {
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.into(), vec![step]);
        let id = paused(s, chat, prompt).await?;
        assert_counts(s, &id, 1, 1)?;
        if prompt == LINKED_WRITE {
            // A link in the project that leads outside shows where it leads.
            let real =
                butler_platform::secure_fs::canonicalize(outside.with_file_name("linked-out"))?
                    .join("note.txt");
            let card = &s.gw.approval_requests(chat).await?[0]["approval"];
            assert_eq!(card["examples"], json!([real]), "{card}");
            assert_eq!(card["risk"], "high", "{card}");
        }
        approve(s, chat, "deny").await?;
        delivered(s, chat, &id).await?;
        assert_counts(s, &id, 1, 0)?;
    }
    assert_eq!(std::fs::read_to_string(outside)?, "outside-marker");
    assert!(!outside.with_extension("new").exists());
    assert!(
        !outside
            .with_file_name("linked-out")
            .join("note.txt")
            .exists()
    );
    eprintln!(
        "PERM-02 risky: outside_rm=asked git=asked outside_write=asked linked_write=asked network=asked"
    );
    Ok(())
}

/// D5: a standing "allow in this conversation" covers a network command until
/// the turn reads external content; then the same command asks again.
async fn external_content_reasks(
    s: &mut Scenario,
    chat: &str,
    script: &Arc<Script>,
    outside: &Path,
) -> Result<(), HarnessError> {
    let net = |id: &str| {
        call(
            id,
            "run_command",
            &json!({"command":"echo remote-ok","summary":"Check remote","state_effect":"remote_observation"}),
        )
    };
    let read_outside = call(
        "outside-read",
        "read_file",
        &json!({"requests":[{"path":outside.to_string_lossy()}]}),
    );
    let rounds = [
        ("Check the remote once.", vec![net("net-echo")]),
        ("Check the remote again.", vec![net("net-echo")]),
        (
            "Read the outside note, then check the remote.",
            vec![read_outside, net("net-echo"), net("net-after-restart")],
        ),
    ];
    for (prompt, steps) in &rounds {
        script
            .rounds
            .lock()
            .unwrap()
            .insert((*prompt).into(), steps.clone());
    }
    let id = paused(s, chat, rounds[0].0).await?;
    decide_all(s, chat, "allow", "conversation").await?;
    delivered(s, chat, &id).await?;
    assert_counts(s, &id, 1, 0)?;

    let id = s.gw.say_turn(chat, rounds[1].0).await?;
    delivered(s, chat, &id).await?;
    assert_counts(s, &id, 0, 0)?;

    let id = paused(s, chat, rounds[2].0).await?;
    assert_counts(s, &id, 1, 1)?;
    decide_all(s, chat, "allow", "once").await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.gw.approval_requests(chat).await?.is_empty() {
        assert!(
            Instant::now() < deadline,
            "the granted network command did not ask again after external content\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_counts(s, &id, 2, 1)?;
    let cards = s.gw.approval_requests(chat).await?;
    assert_eq!(cards[0]["reason"], "authority.taintReason");
    s.restart().await?;
    decide_all(s, chat, "allow", "once").await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.gw.approval_requests(chat).await?.is_empty() {
        assert!(Instant::now() < deadline, "taint was lost across restart");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_counts(s, &id, 3, 1)?;
    assert_eq!(
        s.gw.approval_requests(chat).await?[0]["reason"],
        "authority.taintReason"
    );
    decide_all(s, chat, "deny", "once").await?;
    delivered(s, chat, &id).await?;
    eprintln!(
        "PERM-02 taint: granted=honored after_external_read=asked restart_preserved=true authority_count=3"
    );
    Ok(())
}

async fn decide_all(
    s: &Scenario,
    chat: &str,
    action: &str,
    scope: &str,
) -> Result<(), HarnessError> {
    for card in s.gw.approval_requests(chat).await? {
        let reference = card["request_ref"].as_str().unwrap();
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/{action}?session_id={chat}"),
                json!({"scope":scope}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
    }
    Ok(())
}

/// D7 + D8: a new schedule defaults to Auto; its scheduled run fails fast at
/// the step Auto would ask about, and the run is flagged; "run now" asks.
async fn unattended_schedule(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    outside: &Path,
) -> Result<(), HarnessError> {
    let settings =
        s.gw.patch("/settings", json!({"plan_mode_default":true}))
            .await?;
    assert_eq!(settings.status, 200);
    let step = mutation("cleanup", &format!("rm -f '{}'", outside.display()));
    script.rounds.lock().unwrap().insert(
        SCHEDULED.into(),
        vec![
            call(
                "scheduled-note",
                "write_file",
                &json!({"path":"scheduled-note.md","content":"planned auto edit"}),
            ),
            step.clone(),
            done(),
            step,
        ],
    );
    let created =
        s.gw.post(
            "/automations",
            json!({"title":"Nightly", "prompt_body":SCHEDULED, "target_session_id":chat,
                "schedule_type":"once", "run_at":"2000-01-01T00:00:00.000Z"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let automation = created.data()["automation"].clone();
    assert_eq!(automation["access_mode"], "auto", "{automation}");
    let schedule = automation["id"].as_str().unwrap().to_owned();
    let due = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(due.status, 202, "{}", due.text);
    let run = run_where(s, &schedule, |run| {
        run["trigger"] == "scheduled" && run["turn_id"].is_string()
    })
    .await?;
    let turn = run["turn_id"].as_str().unwrap().to_owned();
    let waited = Instant::now();
    delivered(s, chat, &turn).await?;
    let scheduled_turn =
        s.gw.wait_terminal(chat, &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(
        scheduled_turn["execution_controls"]["plan_mode"], true,
        "{scheduled_turn}"
    );
    assert_eq!(
        scheduled_turn["execution_controls"]["access_mode"], "auto",
        "{scheduled_turn}"
    );
    assert_counts(s, &turn, 0, 0)?;
    let scheduled_note = outside
        .parent()
        .unwrap()
        .join("proj/작업 Project/scheduled-note.md");
    assert_eq!(
        std::fs::read_to_string(scheduled_note)?,
        "planned auto edit"
    );
    let output = outputs(s, chat, &turn, script, SCHEDULED).await?;
    assert!(
        output
            .iter()
            .any(|v| v.contains("schedule_permission_required")),
        "{output:?}"
    );
    assert_eq!(std::fs::read_to_string(outside)?, "outside-marker");
    run_where(s, &schedule, |run| {
        run["safe_error_code"] == "schedule_permission_required"
    })
    .await?;
    eprintln!(
        "PERM-02 unattended: delivered_ms={} authority_count=0 run_flagged=true",
        waited.elapsed().as_millis()
    );

    let controls =
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"plan_mode":false}),
        )
        .await?;
    assert_eq!(controls.status, 200);
    let manual =
        s.gw.post(&format!("/automations/{schedule}/run"), json!({}))
            .await?;
    assert_eq!(manual.status, 202, "{}", manual.text);
    let turn = manual.data()["run"]["turn_id"].as_str().unwrap().to_owned();
    let paused =
        s.gw.wait_turn(chat, &turn, &["waiting_for_form"], Duration::from_secs(20))
            .await?;
    assert_eq!(paused["state"], "waiting_for_form", "{paused}");
    assert_counts(s, &turn, 1, 1)?;
    approve(s, chat, "deny").await?;
    delivered(s, chat, &turn).await?;
    assert_eq!(std::fs::read_to_string(outside)?, "outside-marker");
    eprintln!("PERM-02 run-now: attended=asked authority_count=1");
    Ok(())
}
