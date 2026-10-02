//! Installed release executable chat smoke, with a local canned provider.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, Exchange, MatchKey, Meta, RequestRecord, ResponseRecord},
    gateway::turn_state,
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::{Value, json};

const PROMPT: &str = "Reply with Windows preview ready.";
const ANSWER: &str = "Windows preview ready.";

#[tokio::test]
async fn installed_release_delivers_one_stub_chat_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("INSTALLED-PREVIEW")?
        .data_folder_token()
        .access(Access::AskFirst)
        .stub_cassette(conversation_stub())
        .env("OPENAI_API_KEY", "e2e-not-a-real-key")
        .env("BUTLER_E2E_APP_NOW", chrono::Utc::now().to_rfc3339());
    if let Some(root) = std::env::var_os("BUTLER_E2E_INSTALLED_ROOT") {
        let root = std::path::PathBuf::from(root);
        setup.sandbox.binary = root.join("butler-agent.exe");
        setup.sandbox.resources = root.join("resources");
        setup.sandbox.install = root;
    }
    let s = setup.start().await?;
    let stored = s.gw.post("/model-catalog/provider-credentials", json!({
        "provider_id":"anthropic", "auth_type":"api_key", "api_key":"sk-e2e-preview-not-real"
    })).await?;
    assert_eq!(stored.status, 201);
    assert_private_credentials(&s.sandbox.data);
    let sent =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general", "text":PROMPT,
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(sent.status, 202);
    let id = accepted_turn_id(sent.data())?;
    let terminal =
        s.gw.wait_terminal("general", &id, Duration::from_secs(60))
            .await?;
    assert_eq!(
        turn_state(&terminal),
        "delivered",
        "provider_calls={}, misses={:?}, terminal={terminal}",
        s.provider()?.served(),
        s.provider()?.misses()
    );
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["text"], PROMPT);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["text"], ANSWER);
    // Wait for completed extraction usage, not a guessed background delay.
    let extraction_count = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let monitor = s.gw.get("/usage-monitor?since_hours=1").await?;
            assert_eq!(monitor.status, 200, "{}", monitor.text);
            let count: u64 = monitor.data()["model"]["byScopeUsage"]
                .as_object()
                .unwrap()
                .iter()
                .filter(|(scope, _)| scope.starts_with("memory-extract:"))
                .map(|(_, usage)| usage["requestCount"].as_u64().unwrap())
                .sum();
            if count > 0 && count == s.provider()?.memory_requests().len() as u64 {
                return Ok::<_, HarnessError>(count);
            }
        }
    })
    .await
    .map_err(|_| {
        butler_e2e::e2e::harness_error("background extraction usage did not complete")
    })??;
    assert_eq!(s.provider()?.served(), 1);
    assert_eq!(s.provider()?.requests().len(), 1);
    assert_eq!(
        s.provider()?.memory_requests().len() as u64,
        extraction_count
    );
    eprintln!("conversation calls: 1; completed extraction calls: {extraction_count}");
    s.finish().await?;
    Ok(())
}

fn assert_private_credentials(data: &std::path::Path) {
    for relative in [
        "auth/model-provider-credentials.json",
        "auth/credential-store.json",
        "app/runtime/auth/local-agent-auth.json",
        "app/runtime/auth/local-admin.json",
        "state/app-gateway/project-folder-token-secret",
    ] {
        assert_eq!(
            butler_platform::secure_fs::is_private(&data.join(relative)),
            Some(true),
            "private credential path: {relative}"
        );
    }
}

fn reply() -> Value {
    json!({"id":"resp_preview", "object":"response", "status":"completed", "model":"gpt-6-luna",
        "output":[{"type":"message","id":"msg_preview","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":ANSWER,"annotations":[]}]}],
        "usage":{"input_tokens":100,"output_tokens":4,"total_tokens":104}})
}

fn conversation_stub() -> Cassette {
    Cassette {
        scenario: "INSTALLED-PREVIEW".into(),
        meta: Meta {
            provider: "openai".into(),
            model: "openai/gpt-6-luna".into(),
            effort: Some("low".into()),
            ..Meta::default()
        },
        exchanges: vec![Exchange {
            request: RequestRecord {
                method: "POST".into(),
                path: "/responses".into(),
                key: MatchKey {
                    path: "/responses".into(),
                    model: "gpt-6-luna".into(),
                    effort: Some("low".into()),
                    user_request: PROMPT.into(),
                    round: vec![],
                },
            },
            response: ResponseRecord {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                chunks: vec![Chunk {
                    delay_ms: 0,
                    text: reply().to_string(),
                }],
            },
        }],
    }
}
