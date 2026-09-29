//! D. Tool execution (SCENARIOS.md TOOL-01, TOOL-03, TOOL-04, TOOL-05).
//!
//! The general chat's workspace is the data dir `D`, so harness files are
//! written there. Escape attempts are real recorded tool calls whose path
//! argument is rewritten at replay (`ArgsMutation::Replace`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;

use butler_e2e::e2e::faults::{ArgsMutation, Fault, Transform};
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::{HarnessError, nonce};

/// TOOL-01 — Read tool is really executed and shown.
#[tokio::test]
async fn tool_01_read_tool_is_executed_and_shown() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let secret = nonce();
    let setup = Setup::new("TOOL-01")?
        .cassette("TOOL-01")
        .placeholder("NONCE", &secret);
    fs::write(
        setup.sandbox.data.join("notes.txt"),
        format!("the secret word is {secret}\n"),
    )?;
    let mut s = setup.start().await?;
    let (turn_id, turn) = s
        .turn(
            "general",
            "Read the file notes.txt in your workspace and tell me the secret word.",
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let read = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "read_file")
        .expect("read_file row");
    assert_eq!(read["state"], "delivered", "{read}");
    // The nonce exists only on disk: only a real read can put it here.
    let output = s.gw.operation_output(&turn_id, read).await?;
    assert!(
        output.contains(&secret),
        "operation output lacks the nonce: {output}"
    );

    s.restart().await?;
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    assert!(
        rows.iter().any(|row| row["safe_tool_name"] == "read_file"),
        "work block lost on restart"
    );
    s.finish().await
}

/// Tool rows of a turn ordered by event sequence.
fn first_rows(messages: &[serde_json::Value], turn_id: &str) -> Vec<serde_json::Value> {
    let mut rows = tool_rows(messages, turn_id);
    rows.sort_by(|a, b| {
        let key = |row: &serde_json::Value| row["turn_event_sequence"].as_f64().unwrap_or(f64::MAX);
        key(a).total_cmp(&key(b))
    });
    rows
}

const MAKE: &str =
    "Create a file named made.txt in your workspace containing exactly the text: made-by-tool";

/// TOOL-03 — Malformed tool calls go back to the model, not the crash handler:
/// no side effect, a terminal turn, and no service restart.
async fn malformed_call(case: &str, mutation: ArgsMutation) -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let name = format!("TOOL-03-{case}");
    let mut s = Setup::new(&name)?.cassette(&name).start().await?;
    // The model's first write_file call is malformed; its real reaction to the
    // resulting tool error was recorded the same way.
    s.provider()?.inject(Fault::first_call(
        "made.txt",
        Transform::MutateToolArgs(ArgsMutation::OnlyTool {
            tool: "write_file".into(),
            mutation: Box::new(mutation),
        }),
    ))?;
    let before: Vec<_> = fs::read_dir(&s.sandbox.data)?
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    let (turn_id, turn, restarts) = s.turn_supervised("general", MAKE).await?;
    assert_eq!(restarts, 0, "{case}: the service exited and was replaced");
    let state = turn_state(&turn);
    assert!(matches!(state, "delivered" | "failed"), "{case}: {turn}");
    // The malformed call wrote nothing; the model's own valid retry may have
    // created exactly the requested file.
    for entry in fs::read_dir(&s.sandbox.data)?.flatten() {
        let name = entry.file_name();
        if entry.file_type()?.is_file() && !before.contains(&name) {
            assert_eq!(
                name,
                "made.txt",
                "{case}: unexpected file {}",
                name.to_string_lossy()
            );
            assert_eq!(
                fs::read_to_string(entry.path())?.trim_end(),
                "made-by-tool",
                "{case}: garbage"
            );
        }
    }
    let rows = first_rows(&s.gw.messages("general").await?, &turn_id);
    eprintln!("{case} rows: {}", serde_json::Value::Array(rows.clone()));
    let first_write = rows.iter().find(|row| {
        row["safe_tool_name"] == "write_file" || row["safe_tool_name"] == "e2e_nonexistent_tool"
    });
    if let Some(first_write) = first_write {
        assert_ne!(
            first_write["state"], "delivered",
            "{case}: malformed call shown as success: {first_write}"
        );
    } else {
        assert!(!rows.is_empty(), "{case}: tool activity not visible");
    }
    assert!(s.gw.healthy().await);
    s.finish().await
}

#[tokio::test]
async fn tool_03_truncated_arguments() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    malformed_call("truncated", ArgsMutation::Truncate).await
}

#[tokio::test]
async fn tool_03_wrong_argument_types() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    malformed_call("wrong-types", ArgsMutation::WrongTypes).await
}

#[tokio::test]
async fn tool_03_unknown_tool_name() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    malformed_call("unknown-tool", ArgsMutation::UnknownTool).await
}

/// TOOL-04 — Shell tool environment is scrubbed.
#[tokio::test]
async fn tool_04_shell_environment_is_scrubbed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "this scenario replays commands recorded for a POSIX shell; the Windows shell is covered by butler-turn tests"
    );
    // OPENAI_API_KEY is not used as a canary: it switches OpenAI to API-key
    // mode and away from the recorded subscription endpoint.
    let canaries: Vec<(String, String)> = [
        "BUTLER_E2E_CANARY",
        "AWS_SECRET_ACCESS_KEY",
        "ANTHROPIC_API_KEY",
    ]
    .iter()
    .map(|key| {
        (
            (*key).to_owned(),
            format!("e2e-canary-{}", uuid::Uuid::new_v4().simple()),
        )
    })
    .collect();
    let mut setup = Setup::new("TOOL-04")?.cassette("TOOL-04");
    for (key, value) in &canaries {
        setup = setup.env(key, value.clone());
    }
    let s = setup.start().await?;
    let (turn_id, turn) = s
        .turn(
            "general",
            "Use the run_command tool to run exactly `pwd; env | sort` in your workspace, then tell me how many lines the output had.",
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let run = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "run_command")
        .expect("run_command row");
    let output = s.gw.operation_output(&turn_id, run).await?;
    // The command really ran in the scenario's workspace (a per-run path).
    let data = s.sandbox.data.display().to_string();
    assert!(
        output.contains(&data) || output.contains("PATH="),
        "command did not run: {output}"
    );
    let export =
        s.gw.get("/transcript-export?session_id=general")
            .await?
            .text;
    let messages = s.gw.get("/messages?chat_id=general").await?.text;
    let logs = s.agent.logs();
    for (key, value) in &canaries {
        for (surface, text) in [
            ("operation output", &output),
            ("export", &export),
            ("messages", &messages),
            ("logs", &logs),
        ] {
            assert!(
                !text.contains(value.as_str()),
                "{key} canary leaked into {surface}"
            );
        }
    }
    s.finish().await
}

const INSIDE: &str =
    "Create a file named inside.txt in your workspace containing exactly the text: hello-e2e";

/// TOOL-05 — Workspace escape is refused: the target is untouched, the
/// installation dir unchanged, the refusal visible, the turn terminal and the
/// service not replaced.
async fn escape(case: &str) -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let name = format!("TOOL-05-{case}");
    let setup = Setup::new(&name)?.cassette(&name);
    let root = setup.sandbox.root.clone();
    butler_platform::secure_fs::symlink(&setup.sandbox.home, &setup.sandbox.data.join("link"))?;
    fs::write(root.join("outside.txt"), "original-outside")?;
    let (path, target) = match case {
        "parent" => ("../outside.txt".to_owned(), root.join("outside.txt")),
        "absolute" => (
            root.join("outside-abs.txt").display().to_string(),
            root.join("outside-abs.txt"),
        ),
        "symlink" => (
            "link/escaped.txt".to_owned(),
            setup.sandbox.home.join("escaped.txt"),
        ),
        _ => {
            let target = setup.sandbox.install.join("resources/escaped.txt");
            (target.display().to_string(), target)
        }
    };
    let installation_before = setup.sandbox.installation_fingerprint()?;
    let mut s = setup.start().await?;
    let before = fs::read(&target).ok();
    // The model's first write_file call targets the escaping path.
    s.provider()?.inject(Fault::first_call(
        "inside.txt",
        Transform::MutateToolArgs(ArgsMutation::OnlyTool {
            tool: "write_file".into(),
            mutation: Box::new(ArgsMutation::Replace {
                from: "inside.txt".into(),
                to: path,
            }),
        }),
    ))?;
    let (turn_id, turn, restarts) = s.turn_supervised("general", INSIDE).await?;
    assert_eq!(
        fs::read(&target).ok(),
        before,
        "{case}: escape wrote {}",
        target.display()
    );
    assert_eq!(
        s.sandbox.installation_fingerprint()?,
        installation_before,
        "{case}: installation dir changed"
    );
    assert_eq!(restarts, 0, "{case}: the service exited and was replaced");
    assert!(
        matches!(turn_state(&turn), "delivered" | "failed"),
        "{case}: {turn}"
    );
    let rows = first_rows(&s.gw.messages("general").await?, &turn_id);
    eprintln!("{case} rows: {}", serde_json::Value::Array(rows.clone()));
    let write = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "write_file")
        .unwrap_or_else(|| panic!("{case}: write attempt not visible"));
    assert_ne!(
        write["state"], "delivered",
        "{case}: refusal not visible: {write}"
    );
    s.finish().await
}

#[tokio::test]
async fn tool_05_parent_directory_escape() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    escape("parent").await
}

#[tokio::test]
async fn tool_05_absolute_path_escape() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    escape("absolute").await
}

#[tokio::test]
async fn tool_05_symlink_escape() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    escape("symlink").await
}

#[tokio::test]
async fn tool_05_installation_dir_write() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    escape("installation").await
}
