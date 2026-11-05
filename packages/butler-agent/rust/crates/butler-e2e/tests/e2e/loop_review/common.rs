//! Shared local-model scenario runner for agent-loop regressions.
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer, LocalCapabilities},
};
use serde_json::Value;

pub(super) struct Run {
    pub(super) requests: Vec<Value>,
    pub(super) turn: Value,
    pub(super) reply: Option<Value>,
}

/// Runs one turn against a scripted local model; returns the tool-bearing
/// requests, the terminal turn and the delivered assistant message.
pub(super) async fn run(id: &str, script: Vec<Value>, prompt: &str) -> Result<Run, HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        script,
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = crate::setup_local_models::with_local_server(id, &server).await?;
    crate::setup_local_models::use_local_model(&s, &server.base_url).await?;
    let (turn_id, turn) = s.turn("general", prompt).await?;
    let reply =
        s.gw.messages("general")
            .await?
            .into_iter()
            .find(|m| m["role"] == "assistant" && m["turn_id"] == turn_id);
    let requests = server
        .chat_requests()
        .into_iter()
        .filter(|r| r["stream"] != true && r["tools"].is_array())
        .collect();
    s.finish().await?;
    Ok(Run {
        requests,
        turn,
        reply,
    })
}
