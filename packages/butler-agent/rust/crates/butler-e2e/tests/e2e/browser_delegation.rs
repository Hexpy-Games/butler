//! Real delegated tool execution must use the public parent's browser lease.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::steward_presentation::stub;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use reqwest::{Method, Response};
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};

#[tokio::test]
async fn delegated_browser_tools_use_public_parent_ownership() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.browser.store(true, Ordering::SeqCst);
    let s = Setup::new("BROWSER-DELEGATION")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let host = tokio::spawn(serve_host(stream, admin));
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(30), host)
        .await
        .unwrap()
        .unwrap()?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = view.data()["steward_children"][0]["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(child, "");
    assert_ne!(child, "general");
    let navigation = s.gw.get("/navigation").await?;
    assert!(
        !navigation.text.contains(&child),
        "internal child in sidebar"
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let session: String = db.query_row(
        "SELECT t.session_id FROM btcc_guided_tool_calls c JOIN btcc_turns t ON t.turn_id=c.turn_id WHERE c.tool_name='browser_open'",
        [], |row| row.get(0)).unwrap();
    assert_eq!(session, child, "tool really ran in the internal child");
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn serve_host(mut stream: Response, admin: AdminClient) -> Result<(), HarnessError> {
    let mut buffer = String::new();
    for op in ["tab.open", "tabs.list", "tab.observe"] {
        let frame = next_call(&mut stream, &mut buffer, op).await?;
        assert_eq!(
            frame["session"], "general",
            "internal session reached browser host: {frame}"
        );
        let tab = json!({"id":"parent-tab","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com/"});
        if op == "tab.open" {
            let event = admin
                .send(
                    Method::POST,
                    "/internal/browser-host/events",
                    Some(json!({"tabs":[tab]})),
                    &[],
                )
                .await?;
            assert_eq!(event.status, 200);
        }
        let result = match op {
            "tabs.list" => json!({"tabs":[tab]}),
            "tab.observe" => {
                json!({"status":"ok","tab":"parent-tab","obs":"observation","url":"https://example.com/","text":"Parent page"})
            }
            _ => json!({"status":"ok","tab":"parent-tab","url":"https://example.com/"}),
        };
        assert!(!result.to_string().contains("steward"));
        let reply = admin
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
        assert_eq!(reply.status, 200);
        if op != "tabs.list" {
            let ended = next_frame(&mut stream, &mut buffer).await?;
            assert_eq!(ended["op"], "use.ended");
            assert_eq!(ended["session"], "general");
            assert_eq!(ended["turn_id"], frame["turn_id"]);
            assert_eq!(ended["args"]["id"], frame["id"]);
            assert_eq!(ended["args"]["abort"], false);
        }
    }
    Ok(())
}

async fn next_call(
    stream: &mut Response,
    buffer: &mut String,
    op: &str,
) -> Result<Value, HarnessError> {
    let started = if op == "tabs.list" {
        None
    } else {
        let frame = next_frame(stream, buffer).await?;
        assert_eq!(frame["op"], "use.started");
        assert_eq!(frame["session"], "general");
        Some(frame)
    };
    let frame = next_frame(stream, buffer).await?;
    assert_eq!(frame["op"], op);
    if let Some(started) = started {
        assert_eq!(started["id"], frame["id"]);
        assert_eq!(started["tab"], frame["tab"]);
        assert_eq!(started["turn_id"], frame["turn_id"]);
    }
    Ok(frame)
}

pub(super) async fn next_frame(
    stream: &mut Response,
    buffer: &mut String,
) -> Result<Value, HarnessError> {
    loop {
        if let Some(end) = buffer.find("\n\n") {
            let event = buffer[..end].to_owned();
            buffer.drain(..end + 2);
            if let Some(data) = event.lines().find_map(|line| line.strip_prefix("data: ")) {
                return Ok(serde_json::from_str(data)?);
            }
        } else {
            let chunk = stream.chunk().await?.expect("browser host frame");
            buffer.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }
}
