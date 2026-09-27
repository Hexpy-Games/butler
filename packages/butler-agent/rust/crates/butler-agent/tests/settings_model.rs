//! `PATCH /settings { model }` against the real agent binary and App gateway.
//!
//! Regression: registered Custom models carry no explicit `enabled` flag, the
//! host read that as disabled, and the gateway silently dropped the model
//! while answering 200. The App's auto-save then waited forever.
#![cfg(unix)]
#![allow(
    clippy::unwrap_used,
    reason = "integration test helpers abort the test on setup failure"
)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A scratch directory removed on drop.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The agent process, terminated on drop.
struct Agent(Child);

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// An OpenAI-compatible model server that lists `stub` and `stub-2`.
async fn stub_models() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buffer = vec![0; 8192];
                let _ = stream.read(&mut buffer).await;
                let body = json!({"object":"list","data":[
                    {"id":"stub","object":"model"},{"id":"stub-2","object":"model"}
                ]})
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    address
}

/// Lays out an installation root and a data root with onboarding complete and
/// two registered Custom models, as a first-run App would leave them.
fn install(scratch: &Path, models: SocketAddr) -> (PathBuf, PathBuf, PathBuf) {
    let install = scratch.join("install");
    let resources = install.join("resources");
    let data = scratch.join("data");
    std::fs::create_dir_all(install.join("bin")).unwrap();
    let binary = install.join("bin/butler-agent");
    if std::fs::hard_link(env!("CARGO_BIN_EXE_butler-agent"), &binary).is_err() {
        std::fs::copy(env!("CARGO_BIN_EXE_butler-agent"), &binary).unwrap();
    }
    copy_tree(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../resources"),
        &resources,
    );
    std::fs::create_dir_all(resources.join("app-client/dist")).unwrap();
    std::fs::write(
        resources.join("app-client/dist/index.html"),
        "<!doctype html><title>stub</title>",
    )
    .unwrap();
    std::fs::create_dir_all(data.join("personalization")).unwrap();
    std::fs::create_dir_all(scratch.join("home/.codex")).unwrap();
    let now = "2026-09-27T00:00:00Z";
    std::fs::write(
        data.join("personalization/onboarding.json"),
        json!({"schema":"butler.first_chat_onboarding.v1","status":"complete","gateway":"any",
            "fields":{},"skipped_fields":[],"created_at":now,"updated_at":now,"completed_at":now})
        .to_string(),
    )
    .unwrap();
    let server_url = format!("http://{models}");
    std::fs::write(
        data.join("butler.config.json"),
        json!({
            "user":{"name":"Settings","language":"en"},
            "system":{"defaultModel":"local/stub"},
            "models":{"local":[
                {"model_id":"stub","display_name":"Stub","server_url":server_url,"context_window_tokens":128_000},
                {"model_id":"stub-2","display_name":"Stub 2","server_url":server_url,"context_window_tokens":128_000}
            ]},
            "metrics":{"enabled":false}
        })
        .to_string(),
    )
    .unwrap();
    (binary, resources, data)
}

async fn start(scratch: &Path, models: SocketAddr) -> (Agent, String) {
    let (binary, resources, data) = install(scratch, models);
    let port = free_port();
    let child = Command::new(&binary)
        .arg("--installation-root")
        .arg(scratch.join("install"))
        .arg("--resource-root")
        .arg(&resources)
        .current_dir(&data)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", scratch.join("home"))
        .env("CODEX_HOME", scratch.join("home/.codex"))
        .env("TMPDIR", scratch)
        .env("BUTLER_DATA", &data)
        .env("BUTLER_APP_SERVER_HOST", "127.0.0.1")
        .env("BUTLER_APP_SERVER_PORT", port.to_string())
        .env("BUTLER_METRICS_ENABLED", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut agent = Agent(child);
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if client
            .get(format!("{base}/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            break;
        }
        assert!(
            agent.0.try_wait().unwrap().is_none(),
            "agent exited before its gateway was ready"
        );
        assert!(Instant::now() < deadline, "gateway not ready in 60s");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    (agent, base)
}

async fn patch(base: &str, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .patch(format!("{base}/settings"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}

async fn current_model(base: &str) -> Value {
    let settings: Value = reqwest::get(format!("{base}/settings"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    settings["data"]["model"].clone()
}

#[tokio::test]
async fn patch_settings_switches_to_a_registered_custom_model() {
    let scratch = Scratch(
        std::env::temp_dir().join(format!("butler-settings-model-{}", uuid::Uuid::new_v4())),
    );
    let models = stub_models().await;
    let (_agent, base) = start(&scratch.0, models).await;
    assert_eq!(current_model(&base).await, "local/stub");

    // The App's primary-model select sends this payload on change.
    let (status, body) = patch(
        &base,
        json!({"model":"local/stub-2","reasoning_effort":"none","context_window_tokens":128_000}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["model"], "local/stub-2");
    assert_eq!(current_model(&base).await, "local/stub-2");

    // A model that is not available is rejected with a code, not dropped.
    let (status, body) = patch(&base, json!({"model":"local/missing"})).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(
        body["error"]["code"], "settings_model_unavailable",
        "{body}"
    );
    assert_eq!(current_model(&base).await, "local/stub-2");
}
