//! Installed release executable chat smoke, with a local canned provider.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use axum::{Json, Router, response::IntoResponse, routing::post};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    gateway::turn_state,
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::{Value, json};

const PROMPT: &str = "Reply with Windows preview ready.";
const ANSWER: &str = "Windows preview ready.";

#[tokio::test]
async fn installed_release_delivers_one_stub_chat_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let router = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<Value>| {
            let seen = seen.clone();
            async move {
                assert!(body.to_string().contains(PROMPT));
                seen.fetch_add(1, Ordering::SeqCst);
                Json(reply()).into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    let mut setup = Setup::new("INSTALLED-PREVIEW")?
        .data_folder_token()
        .access(Access::AskFirst)
        .model(ModelChoice {
            model: "openai/gpt-6-luna".into(),
            effort: Some("low".into()),
        })
        .env("OPENAI_API_KEY", "e2e-not-a-real-key")
        .env("OPENAI_BASE_URL", format!("http://{address}/v1"))
        .env("BUTLER_E2E_APP_NOW", chrono::Utc::now().to_rfc3339());
    if let Some(root) = std::env::var_os("BUTLER_E2E_INSTALLED_ROOT") {
        let root = std::path::PathBuf::from(root);
        setup.sandbox.binary = root.join("butler-agent.exe");
        setup.sandbox.resources = root.join("resources");
        setup.sandbox.install = root;
        assert_installed_manifest(&setup.sandbox)?;
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
        "provider_calls={}, terminal={terminal}",
        requests.load(Ordering::SeqCst)
    );
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["text"], PROMPT);
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["text"], ANSWER);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_installed_manifest(
    sandbox: &butler_e2e::e2e::sandbox::Sandbox,
) -> Result<(), HarnessError> {
    let launch = butler_e2e::e2e::agent::Launch::new(sandbox)?;
    let output = launch
        .command()
        .args(["doctor", "--check", "installation", "--json"])
        .output()?;
    assert!(output.status.success(), "installed manifest doctor failed");
    let report: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(report["data"]["status"], "healthy");
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
