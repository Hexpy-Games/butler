//! Hook output on queued messages, and sessions that go away while it waits.
use super::context::{printing, prompts, section, split};
use super::*;

const ACTIVE: &str = "HOOK-ACTIVE-TEXT";
const WAITING: &str = "HOOK-WAITING-TEXT";

/// A hook that prints whatever the file holds when it runs, and that file.
fn changing(setup: &Setup) -> Result<(Value, std::path::PathBuf), HarnessError> {
    let file = setup.sandbox.home.join("hook-text.txt");
    fs::write(&file, ACTIVE)?;
    let mut hook = printing(setup, "changing", "UserPromptSubmit", "");
    hook["env"] = json!({"HOOK_FILE":file});
    Ok((hook, file))
}

async fn wait_prompt(s: &Scenario, ask: &str) -> Result<String, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let tail = format!("## Current request\n{ask}");
    loop {
        if let Some(prompt) = prompts(s)?.into_iter().rev().find(|p| p.ends_with(&tail)) {
            return Ok(prompt);
        }
        assert!(Instant::now() < deadline, "no model request for {ask}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn enqueue(s: &Scenario, ask: &str) -> Result<(), HarnessError> {
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general","text":ask,"client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    Ok(())
}

async fn runs_of(s: &Scenario, id: &str) -> Result<usize, HarnessError> {
    let runs = api(s, Method::GET, "/hooks/runs", None).await?;
    Ok(runs
        .data()
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["hook_id"] == id)
        .count())
}

/// Active turn plus queued follow-up across a graceful shutdown: after restart
/// each runs with its own admitted text, once, with no hook run in the new process.
#[tokio::test]
async fn hooks_context_full_queue_survives_shutdown_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-QUEUE")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let (hook, file) = changing(&setup)?;
    configure(&setup, &[hook])?;
    let mut s = setup.start().await?;
    let (active, waiting) = ("Active ask.", "Waiting ask.");
    // The session title request quotes the ask too; hold both.
    let held = [
        s.provider()?.hold_next_reply(active),
        s.provider()?.hold_next_reply(active),
    ];
    let running = s.gw.say_turn("general", active).await?;
    wait_prompt(&s, active).await?;
    fs::write(&file, WAITING)?;
    enqueue(&s, waiting).await?;
    s.restart().await?;
    drop(held);

    let follow_up = wait_prompt(&s, waiting).await?;
    let (_, current) = split(&follow_up);
    assert_eq!(current.matches(WAITING).count(), 1, "{current}");
    assert!(!current.contains(ACTIVE), "{current}");
    assert_eq!(runs_of(&s, "changing").await?, 0, "restart reran the hook");

    // Shutdown may leave the active turn to rerun or to fail as retryable.
    let turn =
        s.gw.wait_terminal("general", &running, Duration::from_secs(30))
            .await?;
    if turn["state"] == "failed" {
        assert_eq!(turn["retryable"], true, "{turn}");
        let retry =
            s.gw.post(&format!("/turns/{running}/retry"), json!({}))
                .await?;
        assert_eq!(retry.status, 202, "{}", retry.text);
    }
    s.gw.wait_turn("general", &running, &["delivered"], Duration::from_secs(30))
        .await?;
    let retried = wait_prompt(&s, active).await?;
    assert_eq!(retried.matches(ACTIVE).count(), 1, "{retried}");
    assert!(split(&retried).1.contains(ACTIVE), "{retried}");
    assert_eq!(runs_of(&s, "changing").await?, 0, "the rerun ran the hook");
    s.finish().await
}

/// Editing a queued message keeps what the hook said at submission, without rerunning it.
#[tokio::test]
async fn hooks_context_queue_edit_keeps_the_admitted_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-EDIT")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let (hook, file) = changing(&setup)?;
    configure(&setup, &[hook])?;
    let s = setup.start().await?;
    let active = "Active ask.";
    let held = [
        s.provider()?.hold_next_reply(active),
        s.provider()?.hold_next_reply(active),
    ];
    s.gw.say_turn("general", active).await?;
    wait_prompt(&s, active).await?;
    fs::write(&file, WAITING)?;
    enqueue(&s, "Before the edit.").await?;
    let view = s.gw.get("/session-queue?chat_id=general").await?;
    let id = view.data()["queued_messages"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::write(&file, "HOOK-LATER-TEXT")?;
    let edited = "After the edit.";
    let patched =
        s.gw.patch(&format!("/session-queue/{id}"), json!({"text":edited}))
            .await?;
    assert_eq!(patched.status, 200, "{}", patched.text);
    drop(held);
    let prompt = wait_prompt(&s, edited).await?;
    let (_, current) = split(&prompt);
    assert_eq!(section(&prompt).matches(WAITING).count(), 1, "{current}");
    assert!(!current.contains("HOOK-LATER-TEXT"), "{current}");
    assert_eq!(runs_of(&s, "changing").await?, 2, "the edit reran the hook");
    s.finish().await
}

fn waiting_rows(s: &Scenario) -> Result<u64, HarnessError> {
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    Ok(db.query_row(
        "SELECT COUNT(*) FROM session_start_hook_context",
        [],
        |row| row.get(0),
    )?)
}

#[tokio::test]
async fn hooks_context_deleting_a_session_removes_its_waiting_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-DELETE")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let start = printing(&setup, "start", "SessionStart", "HOOK-START-TEXT");
    configure(&setup, &[start])?;
    let s = setup.start().await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Gone"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap();
    assert_eq!(waiting_rows(&s)?, 1);
    let deleted =
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    assert_eq!(waiting_rows(&s)?, 0);
    s.finish().await
}

/// The session goes while its hook runs: the text has nowhere to go, and that
/// fails neither the creation nor the sessions after it.
#[tokio::test]
async fn hooks_context_session_deleted_mid_hook_does_not_fail_creation() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-MIDHOOK")?.env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    let held = setup.sandbox.home.join("hook-held");
    let release = setup.sandbox.home.join("hook-release");
    configure(
        &setup,
        &[
            json!({"id":"hold","event":"SessionStart","type":"command","args":fixture(&setup,"hold"),
            "timeout_ms":60000,"env":{"HOOK_HELD":held,"HOOK_RELEASE":release,"HOOK_TEXT":"HOOK-LATE-TEXT"}}),
        ],
    )?;
    let s = setup.start().await?;
    let (created, ()) = tokio::join!(
        s.gw.post("/sessions", json!({"kind":"chat","title":"Goes mid-hook"})),
        async {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !held.exists() {
                assert!(Instant::now() < deadline, "the hook never started");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let sessions = s.gw.get("/sessions").await.unwrap();
            let id = sessions.data()["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|session| session["title"] == "Goes mid-hook")
                .expect("published before its hook")["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let deleted =
                s.gw.delete(&format!("/sessions/{id}?permanent=true"))
                    .await
                    .unwrap();
            assert_eq!(deleted.status, 200, "{}", deleted.text);
            fs::write(&release, b"").unwrap();
        }
    );
    assert_ne!(created?.status, 500);
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert_eq!(runs.data()[0]["context_bytes"], "HOOK-LATE-TEXT".len());
    assert_eq!(waiting_rows(&s)?, 0);
    // The held hook's fixture is gone by now, so this hook list has nothing to wait for.
    replace(&s, vec![]).await?;
    assert_eq!(
        s.gw.post("/sessions", json!({"kind":"chat","title":"Next"}))
            .await?
            .status,
        201
    );
    s.finish().await
}

/// A first message that fails before the turn is handed over leaves the session's
/// SessionStart text waiting, and the next message gets it, once.
#[tokio::test]
async fn hooks_context_failed_first_dispatch_keeps_session_start_text() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = setup("HOOK-CONTEXT-FIRST")?
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    let text = "HOOK-START-TEXT";
    configure(&setup, &[printing(&setup, "start", "SessionStart", text)])?;
    let s = setup.start().await?;
    let held = s.sandbox.data.join("e2e-dispatch-ready-held");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !held.exists() {
        assert!(Instant::now() < deadline, "never reached the barrier");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"First"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let refused =
        s.gw.post("/messages", json!({"chat_id":chat,"text":"Refused first."}))
            .await?;
    assert_eq!(refused.status, 503, "{}", refused.text);
    assert_eq!(waiting_rows(&s)?, 1, "the failed dispatch took the text");

    fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )?;
    butler_e2e::e2e::readiness::wait_ready(&s.sandbox.data, &s.gw, Duration::from_secs(10), |_| {
        true
    })
    .await?;
    assert_eq!(
        s.turn(&chat, "Admitted next.").await?.1["state"],
        "delivered"
    );
    let next = wait_prompt(&s, "Admitted next.").await?;
    assert_eq!(split(&next).1.matches(text).count(), 1, "{next}");
    assert_eq!(waiting_rows(&s)?, 0);
    assert_eq!(s.turn(&chat, "After that.").await?.1["state"], "delivered");
    let after = wait_prompt(&s, "After that.").await?;
    assert!(!split(&after).1.contains(text), "{after}");
    s.finish().await
}
