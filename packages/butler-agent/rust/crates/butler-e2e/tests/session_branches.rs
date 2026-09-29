//! App branch requests (`POST /space/branches`): a new conversation or
//! project from a settled answer, seeded with a summary of the source. The
//! native cutover dropped the route; project sessions are valid sources.
//!
//! The model is a loopback stand-in (`e2e::fake_servers`) registered as the
//! default local model, so the source turns and the branch summary need no
//! cassette and the summary request can be inspected.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::fixtures;
use butler_e2e::e2e::gateway::{TERMINAL, turn_state};
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use serde_json::{Value, json};

const QUESTION: &str = "Plan the spring garden beds.";
/// A made-up steward result; it must never reach a branch summary.
const RESULT: &str = "Delegated finding: the soil pH is 6.4 (made up for the test).";
const RELATION: &str = "relation-00beef01";
/// The branch summarizer's instructions (`topic_branch.rs`).
const SUMMARY_MARK: &str = "Summarize the quoted conversation for a new conversation.";

async fn start(id: &str, server: &FakeServer) -> Result<Scenario, HarnessError> {
    let setup = Setup::new(id)?
        .fixture(Fixture::Empty)
        .env("BUTLER_OLLAMA_BASE_URL", server.base_url.clone());
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data)?;
    let s = setup.start().await?;
    let model =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id": "local", "api_type": "openai_compatible", "platform": "ollama",
                "server_url": server.base_url, "model_id": LOCAL_MODEL, "display_name": LOCAL_MODEL,
                "context_window_tokens": 131_072, "source": "discovered"
            }),
        )
        .await?;
    assert_eq!(model.status, 201, "{}", model.text);
    let model_ref = model.data()["model"]["model_ref"].as_str().unwrap();
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model": model_ref, "access_mode": "full_access"}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    Ok(s)
}

/// A project session with an answer, then a steward result and its answer;
/// returns (project id, session id, id of the last settled answer).
async fn project_source(s: &Scenario) -> Result<(String, String, String), HarnessError> {
    let project =
        s.gw.post(
            "/projects",
            json!({"source": "scratch", "display_name": "Garden"}),
        )
        .await?;
    assert!(project.status < 300, "{}", project.text);
    let project_id = project.data()["project"]["id"].as_str().unwrap().to_owned();
    let session =
        s.gw.post(
            "/sessions",
            json!({"kind": "project", "project_id": project_id, "title": "Beds"}),
        )
        .await?;
    assert_eq!(session.status, 201, "{}", session.text);
    let chat = session.data()["session"]["id"].as_str().unwrap().to_owned();
    s.turn(&chat, QUESTION).await?;

    let settings = s.gw.settings().await?;
    let delivered =
        s.gw.post(
            "/internal/subsession-result",
            json!({
                "relation_id": RELATION, "result_id": "steward-result-00beef01",
                "safe_title": "Soil", "parent_chat_id": chat, "text": RESULT,
                "model_ref": settings["model"], "reasoning_effort": settings["reasoning_effort"],
                "access_mode": "full_access",
            }),
        )
        .await?;
    assert_eq!(delivered.status, 202, "{}", delivered.text);
    wait_settled(s, &chat, 2).await?;
    let answer =
        s.gw.messages(&chat)
            .await?
            .into_iter()
            .rev()
            .find(|message| message["role"] == "assistant" && message["status"] == "delivered")
            .expect("a settled answer");
    Ok((project_id, chat, answer["id"].as_str().unwrap().to_owned()))
}

async fn wait_settled(s: &Scenario, chat: &str, count: usize) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let turns = s.gw.turns(chat).await?;
        if turns.len() == count
            && turns
                .iter()
                .all(|turn| TERMINAL.contains(&turn_state(turn)))
        {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "turns not settled: {turns:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn branch_body(chat: &str, answer: &str, id: &str, title: &str, destination: Value) -> Value {
    json!({
        "requestId": id, "sourceSessionId": chat, "sourceMessageId": answer,
        "title": title, "destination": destination,
    })
}

/// The summary requests the stand-in received after the first `seen` ones.
fn summary_requests(server: &FakeServer, seen: usize) -> Vec<String> {
    server.chat_requests()[seen..]
        .iter()
        .map(Value::to_string)
        .filter(|body| body.contains(SUMMARY_MARK))
        .collect()
}

/// BRANCH-01 — From a project-session answer, `POST /space/branches` creates
/// a chat, a session in an existing project and a new project (named by
/// `destination.name`). Each is seeded from the clicked answer, and the
/// summary reads the source conversation without the steward result that
/// reached it as model input.
#[tokio::test]
async fn branch_01_project_answer_branches_to_every_destination() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        answer: "Raised beds along the south fence.".into(),
        chunk_delay: Duration::from_millis(5),
        ..ChatBehavior::default()
    })
    .await?;
    let s = start("BRANCH-01", &server).await?;
    let (project_id, chat, answer) = project_source(&s).await?;

    let destinations = [
        ("branch-chat", "Beds chat", json!({"kind": "chat"})),
        (
            "branch-project",
            "Beds follow-up",
            json!({"kind": "project", "projectId": project_id}),
        ),
        (
            "branch-new-project",
            "Beds plan",
            json!({"kind": "new_project", "name": "Garden annex"}),
        ),
    ];
    for (id, title, destination) in destinations {
        let seen = server.chat_requests().len();
        let kind = destination["kind"].as_str().unwrap().to_owned();
        let reply =
            s.gw.post(
                "/space/branches",
                branch_body(&chat, &answer, id, title, destination),
            )
            .await?;
        assert_eq!(reply.status, 200, "{kind}: {}", reply.text);
        let session = &reply.data()["session"];
        let seed = &reply.data()["seed"];
        assert_eq!(session["title"], title, "{}", reply.text);
        assert_eq!(seed["sourceSessionId"], chat.as_str(), "{}", reply.text);
        assert_eq!(seed["sourceMessageId"], answer.as_str(), "{}", reply.text);
        match kind.as_str() {
            "chat" => assert!(session["project_id"].is_null(), "{}", reply.text),
            "project" => assert_eq!(session["project_id"], project_id.as_str()),
            _ => {
                let created = session["project_id"].as_str().unwrap();
                assert_ne!(created, project_id);
                let navigation = s.gw.get("/navigation").await?;
                let project = navigation.data()["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|project| project["id"] == created)
                    .cloned()
                    .unwrap();
                assert_eq!(project["display_name"], "Garden annex", "{project}");
            }
        }
        let summaries = summary_requests(&server, seen);
        assert!(!summaries.is_empty(), "{kind}: no summary request");
        for body in summaries {
            assert!(body.contains(QUESTION), "{kind}: source missing: {body}");
            assert!(
                !body.contains("soil pH"),
                "{kind}: steward result leaked: {body}"
            );
        }
    }
    s.finish().await
}

/// BRANCH-02 — Malformed App branch requests answer 400
/// `branch_request_invalid` before any work: a `followUp` (the App never
/// starts work there), a project destination without its id, an unknown
/// destination, a missing source answer and a body that is not JSON.
#[tokio::test]
async fn branch_02_invalid_requests_are_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BRANCH-02")?.start().await?;
    let mut follow_up = branch_body("general", "m", "b1", "T", json!({"kind": "chat"}));
    follow_up["followUp"] = json!("continue there");
    let mut missing_answer = branch_body("general", "m", "b4", "T", json!({"kind": "chat"}));
    missing_answer
        .as_object_mut()
        .unwrap()
        .remove("sourceMessageId");
    let bodies = [
        follow_up.to_string(),
        branch_body("general", "m", "b2", "T", json!({"kind": "project"})).to_string(),
        branch_body("general", "m", "b3", "T", json!({"kind": "folder"})).to_string(),
        missing_answer.to_string(),
        "{not json".to_owned(),
    ];
    for body in bodies {
        let reply =
            s.gw.send(reqwest::Method::POST, "/space/branches", Some(body.clone()))
                .await?;
        assert_eq!(reply.status, 400, "{body}: {}", reply.text);
        assert_eq!(
            reply.error_code(),
            Some("branch_request_invalid"),
            "{body}: {}",
            reply.text
        );
    }
    s.finish().await
}
