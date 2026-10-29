//! General terminal conditions through the real model/tool/approval loop.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::{tool_rows, turn_state},
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::Duration;

#[path = "support/paused_transcript.rs"]
mod paused_transcript;
#[path = "turn_continuation/text_arguments.rs"]
mod text_arguments;

pub(super) async fn setup(
    mode: stub::Mode,
    access: Access,
) -> Result<
    (
        butler_e2e::e2e::scenario::Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(mode).await?;
    let setup = Setup::new("TURN-CONTINUATION")?
        .access(access)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    *script.file_root.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    Ok((s, script, server))
}

pub(super) use stub::Mode;

#[tokio::test]
async fn checkpoint_open_disposition_and_progress_continue_until_work_is_done()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::Progress, Access::FullAccess).await?;
    let (id, turn) = s.turn("general", stub::REQUEST).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = script.requests.lock().unwrap().clone();
    let metrics = super::token_metrics::report(&s, &requests, "Work/final replay")?;
    assert!(
        metrics
            .iter()
            .skip(1)
            .all(|row| row["prefixDiagnostics"]["appendOnly"] == true)
    );
    assert_eq!(requests.len(), 9, "open progress ended the turn");
    assert!(
        requests[5]["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty()),
        "open disposition must retain working tools"
    );
    assert!(
        requests[6]
            .to_string()
            .contains("Only progress/bookkeeping is recorded")
    );
    assert!(
        requests[6]
            .to_string()
            .contains("Continue any unfinished work")
    );
    let messages = s.gw.messages("general").await?;
    assert!(
        tool_rows(&messages, &id)
            .iter()
            .any(|row| row["safe_tool_name"] == "run_command")
    );
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "The total is 42.")
    );
    s.finish().await?;
    server.abort();
    super::steward_presentation::unfinished_disposition_recovers_in_child().await?;
    Ok(())
}
#[tokio::test]
async fn reasoning_only_response_and_todo_updates_continue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (mode, count) in [
        (stub::Mode::Reasoning, 2),
        (stub::Mode::Commentary, 2),
        (stub::Mode::Todo, 5),
    ] {
        let (s, script, server) = setup(mode, Access::FullAccess).await?;
        let (_, turn) = s.turn("general", stub::REQUEST).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        assert_eq!(script.requests.lock().unwrap().len(), count);
        let messages = s.gw.messages("general").await?;
        assert!(
            messages
                .iter()
                .any(|m| m["role"] == "assistant" && m["text"] == "The total is 42.")
        );
        if matches!(mode, stub::Mode::Todo) {
            let records =
                std::fs::read_dir(s.sandbox.data.join("todos"))?.collect::<Result<Vec<_>, _>>()?;
            assert_eq!(records.len(), 1, "TODO must be an ordinary record file");
            let todo: serde_json::Value =
                serde_json::from_slice(&std::fs::read(records[0].path())?)?;
            assert!(todo["list_id"].as_str().unwrap().ends_with(":main"));
            assert_eq!(todo["items"].as_array().unwrap().len(), 1);
            assert_eq!(todo["items"][0]["content"], "Calculate total");
            assert_eq!(todo["items"][0]["status"], "completed");
        }
        s.finish().await?;
        server.abort();
    }
    Ok(())
}
#[tokio::test]
async fn pending_approval_pauses_without_automatic_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup(stub::Mode::Approval, Access::AskAlways).await?;
    let id = accepted_turn_id(&s.gw.say("general", stub::REQUEST).await?)?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    assert_eq!(script.requests.lock().unwrap().len(), 1);
    let cards = s.gw.approval_requests("general").await?;
    assert_eq!(cards.len(), 1);
    paused_transcript::assert_authority_message(&s, false).await?;
    let reference = cards[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202);
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = script.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    super::prompt_history::approval_parity(&s, &id, &requests)?;
    if std::env::var("BUTLER_PROMPT_MAIN_RECORD").as_deref() == Ok("1") {
        s.finish().await?;
        server.abort();
        return Ok(());
    }
    let metrics = super::token_metrics::report(&s, &requests, "Approval resume layout")?;
    assert_eq!(
        metrics[1]["prefixDiagnostics"]["trigger"],
        "authority-resume"
    );
    assert_eq!(
        metrics[0]["prefixDiagnostics"]["instructionComponents"],
        metrics[1]["prefixDiagnostics"]["instructionComponents"]
    );
    assert_eq!(metrics[1]["prefixDiagnostics"]["appendOnly"], true);
    paused_transcript::assert_authority_message(&s, true).await?;
    s.restart().await?;
    paused_transcript::assert_authority_message(&s, true).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn pending_question_pauses_and_answer_resumes_same_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup(stub::Mode::Question, Access::FullAccess).await?;
    let id = accepted_turn_id(&s.gw.say("general", stub::REQUEST).await?)?;
    let paused =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&paused), "waiting_for_form", "{paused}");
    assert_eq!(script.requests.lock().unwrap().len(), 1);
    paused_transcript::assert_segments(&s, false).await?;
    let response = s.gw.get("/session-view?session_id=general").await?;
    let view = response.data();
    let reference = view["pending_questions"][0]["request_ref"]
        .as_str()
        .unwrap();
    let reply = s.gw.post(&format!("/authority-requests/{reference}/answer?session_id=general"),
        json!({"status":"answered","answers":[{"id":"format","selected":["brief"],"custom":null}]})).await?;
    assert_eq!(reply.status, 202);
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    assert_eq!(script.requests.lock().unwrap().len(), 2);
    paused_transcript::assert_segments(&s, true).await?;
    s.restart().await?;
    paused_transcript::assert_segments(&s, true).await?;
    let messages = s.gw.messages("general").await?;
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "The total is 42.")
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn empty_and_text_calls_receive_feedback_until_the_model_recovers() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for mode in [stub::Mode::Empty, stub::Mode::Prose] {
        let (s, script, server) = setup(mode, Access::FullAccess).await?;
        let (_, turn) = s.turn("general", stub::REQUEST).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let messages = s.gw.messages("general").await?;
        let answer = messages.iter().find(|m| m["role"] == "assistant").unwrap()["text"]
            .as_str()
            .unwrap();
        assert_eq!(answer, "The total is 42.");
        let requests = script.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 6);
        assert!(requests[5].to_string().contains("occurred 5 times"));
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn approval_resume_preserves_actor_feedback_counts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::ApprovalRecovery, Access::AskAlways).await?;
    let id = accepted_turn_id(&s.gw.say("general", stub::REQUEST).await?)?;
    let paused =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&paused), "waiting_for_form");
    assert_eq!(script.requests.lock().unwrap().len(), 2);
    let cards = s.gw.approval_requests("general").await?;
    let reference = cards[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202);
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered");
    assert_eq!(
        script.requests.lock().unwrap().len(),
        6,
        "approval must preserve feedback without stopping the actor"
    );
    let messages = s.gw.messages("general").await?;
    assert!(messages.iter().any(|m| m["text"] == "The total is 42."));
    let requests = script.requests.lock().unwrap().clone();
    assert!(requests[5].to_string().contains("occurred 4 times"));
    s.finish().await?;
    server.abort();
    Ok(())
}

mod stub;

#[tokio::test]
async fn commentary_after_output_cut_is_excluded_from_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup(stub::Mode::CutCommentary, Access::FullAccess).await?;
    let (id, turn) = s.turn("general", stub::REQUEST).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let messages = s.gw.messages("general").await?;
    let answer = messages
        .iter()
        .find(|m| m["turn_id"] == id && m["role"] == "assistant")
        .unwrap();
    assert_eq!(answer["text"], "The total is 42.", "{messages:?}");
    assert_eq!(script.requests.lock().unwrap().len(), 3);
    s.finish().await?;
    server.abort();
    Ok(())
}
