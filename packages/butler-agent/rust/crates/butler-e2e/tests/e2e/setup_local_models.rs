//! First-run setup (#230): local model servers. `GET
//! /setup/local-model-servers` finds Ollama and LM Studio, and a local model
//! answers the App as a stream (the existing `message.updated` contract),
//! falling back to one JSON answer when the server refuses to stream.
//!
//! The servers are loopback stand-ins (`e2e::fake_servers`, shapes from the
//! vendors' API references); the agent finds them through
//! `BUTLER_OLLAMA_BASE_URL` and `BUTLER_LM_STUDIO_BASE_URL`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::free_port;
use butler_e2e::e2e::events::{LiveEvents, event_turn_id};
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::fixtures;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup, accepted_turn_id};
use serde_json::{Value, json};

/// A fresh install that finds `ollama` (and no LM Studio: its address is a
/// closed port), with first-conversation onboarding already done.
async fn with_local_server(id: &str, ollama: &FakeServer) -> Result<Scenario, HarnessError> {
    let closed = format!("http://127.0.0.1:{}", free_port()?);
    let setup = Setup::new(id)?
        .fixture(Fixture::Empty)
        .env("BUTLER_OLLAMA_BASE_URL", ollama.base_url.clone())
        .env("BUTLER_LM_STUDIO_BASE_URL", closed);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    setup.start().await
}

/// Registers the server's model as setup does and makes it the default.
async fn use_local_model(s: &Scenario, server_url: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id": "local", "api_type": "openai_compatible", "platform": "ollama",
                "server_url": server_url, "model_id": LOCAL_MODEL, "display_name": LOCAL_MODEL,
                "context_window_tokens": 131_072, "source": "discovered"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let model_ref = reply.data()["model"]["model_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model": model_ref, "access_mode": "full_access"}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    Ok(model_ref)
}

/// SETUP-03 — Local model servers are found on their addresses with their
/// chat models (embedding models left out); an absent server is listed as
/// unreachable. The listed address registers as the server URL.
#[tokio::test]
async fn setup_03_local_model_servers_are_detected() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let ollama = FakeServer::local_models(ChatBehavior::default()).await?;
    let s = with_local_server("SETUP-03", &ollama).await?;
    let started = Instant::now();
    let reply = s.gw.get("/setup/local-model-servers").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "probes are not short"
    );
    let servers = reply.data()["servers"].as_array().unwrap().clone();
    let ids: Vec<_> = servers.iter().map(|server| server["id"].clone()).collect();
    assert_eq!(ids, [json!("ollama"), json!("lm_studio")], "{}", reply.text);
    let found = &servers[0];
    assert_eq!(found["reachable"], true, "{found}");
    assert_eq!(found["base_url"], ollama.base_url.as_str(), "{found}");
    assert_eq!(found["label"], "Ollama", "{found}");
    let models: Vec<_> = found["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(models, [LOCAL_MODEL, "deepseek-r1:latest"], "{found}");
    assert_eq!(
        found["models"][0]["size_bytes"], 2_019_393_189_u64,
        "{found}"
    );
    let absent = &servers[1];
    assert_eq!(absent["reachable"], false, "{absent}");
    assert_eq!(absent["models"], json!([]), "{absent}");

    // LM Studio's shape, when it answers.
    let lm_studio = FakeServer::local_models(ChatBehavior::default()).await?;
    s.finish().await?;
    let s = Setup::new("SETUP-03-LMSTUDIO")?
        .fixture(Fixture::Empty)
        .env(
            "BUTLER_OLLAMA_BASE_URL",
            format!("http://127.0.0.1:{}", free_port()?),
        )
        .env("BUTLER_LM_STUDIO_BASE_URL", lm_studio.base_url.clone())
        .start()
        .await?;
    let reply = s.gw.get("/setup/local-model-servers").await?;
    let lm = &reply.data()["servers"][1];
    assert_eq!(lm["reachable"], true, "{}", reply.text);
    assert_eq!(lm["models"], json!([{"id": "qwen3-8b"}]), "{}", reply.text);
    assert!(
        lm_studio
            .seen()
            .iter()
            .any(|seen| seen.path == "/v1/models"),
        "LM Studio was not asked"
    );

    use_local_model(&s, lm["base_url"].as_str().unwrap()).await?;
    s.finish().await
}

/// The streamed texts of `turn_id` from the live events, in order.
fn streamed_texts(live: &LiveEvents, turn_id: &str) -> Vec<String> {
    live.snapshot()
        .iter()
        .map(|event| &event["payload"]["message"])
        .filter(|message| message["turn_id"] == turn_id && message["status"] == "streaming")
        .map(|message| message["text"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// One turn against `server` with a live listener: the delivered text and
/// the streamed texts of that turn, in order.
async fn streamed_turn(s: &Scenario) -> Result<(String, Vec<String>), HarnessError> {
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let accepted =
        s.gw.say("general", "Say something about local models.")
            .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let delivered =
        s.gw.messages("general").await?.into_iter().find(|message| {
            message["role"] == "assistant" && message["turn_id"] == turn_id.as_str()
        });
    let text = delivered.unwrap()["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok((text, streamed_texts(&live, &turn_id)))
}

/// Every streamed text is a prefix of `answer` (none shows text twice).
fn assert_prefixes(streamed: &[String], answer: &str) {
    assert!(
        streamed
            .iter()
            .all(|text| answer.starts_with(text.as_str())),
        "streamed text is not a prefix of the answer: {streamed:?}"
    );
}

/// SETUP-04 — A local model's answer reaches the App while it arrives: the
/// turn's message is updated with growing partial text before it is
/// delivered, and the agent asked the server to stream.
#[tokio::test]
async fn setup_04_local_model_answers_stream_to_the_app() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let behavior = ChatBehavior::default();
    let answer = behavior.answer.clone();
    let server = FakeServer::local_models(behavior).await?;
    let s = with_local_server("SETUP-04", &server).await?;
    use_local_model(&s, &server.base_url).await?;
    let (delivered, streamed) = streamed_turn(&s).await?;
    assert_eq!(delivered, answer);
    assert!(
        streamed
            .iter()
            .any(|text| !text.is_empty() && text.len() < answer.len()),
        "no partial answer was shown while streaming: {streamed:?}"
    );
    assert_prefixes(&streamed, &answer);
    // Turn rounds stream; one-shot prompts (titles, memory) may not.
    let requests = server.chat_requests();
    assert!(
        requests
            .iter()
            .any(|request| request["stream"] == true && request["tools"].is_array()),
        "no turn round asked to stream: {:?}",
        requests.iter().map(|r| &r["stream"]).collect::<Vec<_>>()
    );
    s.finish().await
}

/// SETUP-04 (retry) — A stream cut off after some text was shown is
/// retried; the text of the cut attempt is dropped, so the App never shows
/// the answer's words twice.
#[tokio::test]
async fn setup_04_retried_stream_does_not_repeat_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let behavior = ChatBehavior {
        cut_first_stream: true,
        ..ChatBehavior::default()
    };
    let answer = behavior.answer.clone();
    let server = FakeServer::local_models(behavior).await?;
    let s = with_local_server("SETUP-04-RETRY", &server).await?;
    use_local_model(&s, &server.base_url).await?;
    let (delivered, streamed) = streamed_turn(&s).await?;
    assert_eq!(delivered, answer);
    assert_prefixes(&streamed, &answer);
    let streams = server
        .chat_requests()
        .iter()
        .filter(|request| request["stream"] == true && request["tools"].is_array())
        .count();
    assert!(streams >= 2, "the cut stream was not retried ({streams})");
    s.finish().await
}

/// SETUP-04 (retry, stop) — Text of a cut stream is dropped before the
/// retry: a turn stopped while the retry is under way keeps no partial
/// answer from the cut attempt.
#[tokio::test]
async fn setup_04_stop_during_a_stream_retry_keeps_no_cut_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let behavior = ChatBehavior {
        cut_first_stream: true,
        hold_later_streams: Duration::from_secs(20),
        ..ChatBehavior::default()
    };
    let server = FakeServer::local_models(behavior).await?;
    let s = with_local_server("SETUP-04-RETRY-STOP", &server).await?;
    use_local_model(&s, &server.base_url).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let accepted =
        s.gw.say("general", "Say something about local models.")
            .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let retried = || {
        server
            .chat_requests()
            .iter()
            .filter(|request| request["stream"] == true && request["tools"].is_array())
            .count()
            >= 2
    };
    while !retried() {
        assert!(Instant::now() < deadline, "the cut stream was not retried");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    live.wait_for(
        deadline.saturating_duration_since(Instant::now()),
        |event| {
            event["type"] == "agent.turn_event"
                && event_turn_id(event) == Some(turn_id.as_str())
                && event["payload"]["event"]["kind"] == "model.stream.completed"
                && event["payload"]["event"]["payload"]["status"] == "discarded"
        },
    )
    .await?;
    let cancel =
        s.gw.post(&format!("/turns/{turn_id}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "cancelled", "{turn}");
    let kept: Vec<_> = s
        .gw
        .messages("general")
        .await?
        .into_iter()
        .filter(|message| message["role"] == "assistant" && message["turn_id"] == turn_id.as_str())
        .filter(|message| !message["text"].as_str().unwrap_or_default().is_empty())
        .collect();
    assert!(kept.is_empty(), "the cut attempt's text was kept: {kept:?}");
    s.finish().await
}

/// SETUP-04 (finish reason) — A stream that ends on its finish reason
/// without `[DONE]` is a complete answer: delivered, streamed, and not
/// asked again without streaming.
#[tokio::test]
async fn setup_04_stream_without_done_completes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let behavior = ChatBehavior {
        omit_done: true,
        ..ChatBehavior::default()
    };
    let answer = behavior.answer.clone();
    let server = FakeServer::local_models(behavior).await?;
    let s = with_local_server("SETUP-04-NODONE", &server).await?;
    use_local_model(&s, &server.base_url).await?;
    let (delivered, streamed) = streamed_turn(&s).await?;
    assert_eq!(delivered, answer);
    assert_prefixes(&streamed, &answer);
    let rounds: Vec<Value> = server
        .chat_requests()
        .iter()
        .filter(|request| request["tools"].is_array())
        .map(|request| request["stream"].clone())
        .collect();
    assert_eq!(rounds, [json!(true)], "{rounds:?}");
    s.finish().await
}

/// SETUP-05 — A server that refuses `stream: true` gets the same round
/// without streaming, and the answer is delivered. The server is not asked
/// to stream again.
#[tokio::test]
async fn setup_05_refused_stream_falls_back_to_one_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let behavior = ChatBehavior {
        refuse_stream: true,
        ..ChatBehavior::default()
    };
    let answer = behavior.answer.clone();
    let server = FakeServer::local_models(behavior).await?;
    let s = with_local_server("SETUP-05", &server).await?;
    use_local_model(&s, &server.base_url).await?;
    for attempt in ["first", "second"] {
        let (turn_id, turn) = s
            .turn("general", &format!("The {attempt} question."))
            .await?;
        assert_eq!(turn_state(&turn), "delivered", "{attempt}: {turn}");
        let delivered = s.gw.messages("general").await?.into_iter().find(|message| {
            message["role"] == "assistant" && message["turn_id"] == turn_id.as_str()
        });
        assert_eq!(delivered.unwrap()["text"], answer.as_str(), "{attempt}");
    }
    let streams: Vec<Value> = server
        .chat_requests()
        .iter()
        .map(|request| request["stream"].clone())
        .collect();
    let first_stream = streams.iter().position(|stream| *stream == json!(true));
    assert!(
        first_stream.is_some(),
        "no round asked to stream: {streams:?}"
    );
    assert_eq!(
        streams
            .iter()
            .filter(|stream| **stream == json!(true))
            .count(),
        1,
        "the refused endpoint was asked to stream again: {streams:?}"
    );
    assert!(
        streams.len() > first_stream.unwrap_or_default() + 2,
        "the rounds were not answered without streaming: {streams:?}"
    );
    s.finish().await
}
