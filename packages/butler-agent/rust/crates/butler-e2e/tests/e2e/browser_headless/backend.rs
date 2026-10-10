//! Backend choice and install trust: an attached App serves new work, a task
//! keeps the backend it started on, and an archive that fails its pinned
//! checks is never run.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, open, publish, selected, setup};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Every file under the browser's state, with size and mtime.
pub(super) fn tree(data: &Path) -> Vec<(String, u64, SystemTime)> {
    fn visit(dir: &Path, out: &mut Vec<(String, u64, SystemTime)>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                visit(&path, out);
            } else {
                out.push((
                    path.to_string_lossy().into_owned(),
                    meta.len(),
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ));
            }
        }
    }
    let mut out = Vec::new();
    visit(&data.join("state/browser"), &mut out);
    out.sort();
    out
}

async fn call_in_turn(
    admin: &AdminClient,
    session: &str,
    turn: &str,
    op: &str,
    tab: &Value,
    args: Value,
) -> Result<Value, HarnessError> {
    let reply = admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":op,"session":session,"turn_id":turn,"tab":tab,"args":args})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{op}: {}", reply.text);
    Ok(reply.body)
}

/// A minimal App host: answers `tab.open` with its own tab and records ops.
async fn app_host(admin: AdminClient, ops: Arc<Mutex<Vec<String>>>) -> Result<(), HarnessError> {
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", admin.gw.base))
        .bearer_auth(&admin.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let mut buffer = String::new();
    loop {
        let frame = crate::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        let op = frame["op"].as_str().unwrap_or("").to_owned();
        if op.starts_with("use.") {
            continue;
        }
        ops.lock().unwrap().push(op.clone());
        let session = frame["session"].as_str().unwrap_or("");
        let result = if op == "tab.open" {
            let tab = json!({"id":"app-tab","owner":format!("conversation:{session}"),"profile":"signed_out","epoch":1,"holder":"agent","url":frame["args"]["url"]});
            admin
                .send(
                    Method::POST,
                    "/internal/browser-host/events",
                    Some(json!({"tabs":[tab]})),
                    &[],
                )
                .await?;
            json!({"status":"ok","tab":"app-tab","url":frame["args"]["url"],"epoch":1,"profile":"signed_out"})
        } else {
            json!({"status":"ok"})
        };
        admin
            .send(
                Method::POST,
                &format!(
                    "/internal/browser-host/results/{}",
                    frame["id"].as_str().unwrap()
                ),
                Some(result),
                &[],
            )
            .await?;
    }
}

#[tokio::test]
async fn attached_app_serves_new_work_and_tasks_never_switch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-BACKEND")?.start().await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    // Without an App, a task's first tab opens headless.
    let mut first = Value::Null;
    for _ in 0..450 {
        first = call_in_turn(
            &admin,
            "task",
            "turn-1",
            "tab.open",
            &Value::Null,
            json!({"url":url}),
        )
        .await?;
        if first["reason"] != "browser_installing" {
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    assert_eq!(first["status"], "ok", "{first}");
    assert!(first["tab"].as_str().unwrap().starts_with('h'), "{first}");
    // The App attaches mid-task.
    let ops = Arc::new(Mutex::new(Vec::new()));
    let host = tokio::spawn(app_host(super::support::admin(&s), ops.clone()));
    tokio::time::sleep(Duration::from_millis(500)).await;
    // The running task keeps its backend: same turn, and a later turn with live tabs.
    for turn in ["turn-1", "turn-2"] {
        let again = call_in_turn(
            &admin,
            "task",
            turn,
            "tab.open",
            &Value::Null,
            json!({"url":url}),
        )
        .await?;
        assert!(
            again["tab"].as_str().unwrap().starts_with('h'),
            "{turn}: {again}"
        );
    }
    let observed = call_in_turn(
        &admin,
        "task",
        "turn-2",
        "tab.observe",
        &first["tab"],
        json!({}),
    )
    .await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    // New work goes to the attached App.
    let app = call_in_turn(
        &admin,
        "fresh",
        "turn-3",
        "tab.open",
        &Value::Null,
        json!({"url":url}),
    )
    .await?;
    assert_eq!(app["tab"], "app-tab", "{app}");
    assert_eq!(
        *ops.lock().unwrap(),
        vec!["tab.open".to_owned()],
        "only the new task reached the App"
    );
    let listed = call(&admin, "task", "tabs.list", &Value::Null, json!({})).await?;
    assert_eq!(listed["tabs"].as_array().unwrap().len(), 3, "{listed}");
    host.abort();
    s.finish().await
}

/// Serves `not a browser` for every request (an archive with the wrong bytes).
async fn tampered_archive_host() -> Result<(String, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await;
            let body = b"not a browser";
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/zip\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(body).await;
        }
    });
    Ok((base, task))
}

#[tokio::test]
async fn unverified_browser_download_is_never_run() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let (base, server) = tampered_archive_host().await?;
    let isolated = tempdir_for("tampered")?;
    let s = setup("BROWSER-HEADLESS-UNVERIFIED")?
        .env(
            "BUTLER_BROWSER_CACHE_DIR",
            isolated.to_string_lossy().into_owned(),
        )
        .env("BUTLER_BROWSER_DOWNLOAD_BASE", base)
        .start()
        .await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let refused = open(&admin, "general", &url).await?;
    assert_eq!(refused["status"], "unavailable", "{refused}");
    assert_eq!(
        refused["reason"], "browser_download_verification_failed",
        "{refused}"
    );
    let mut files = Vec::new();
    let mut stack = vec![isolated.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            if entry.path().is_dir() {
                stack.push(entry.path());
            } else {
                files.push(entry.path());
            }
        }
    }
    assert_eq!(
        files,
        Vec::<std::path::PathBuf>::new(),
        "nothing unverified is kept"
    );
    assert_eq!(
        super::support::browser_processes(&s.sandbox.data.to_string_lossy()),
        Vec::<String>::new()
    );
    server.abort();
    let _ = std::fs::remove_dir_all(&isolated);
    s.finish().await
}

fn tempdir_for(name: &str) -> Result<std::path::PathBuf, HarnessError> {
    let dir = std::env::temp_dir().join(format!(
        "butler-e2e-browser-{name}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
