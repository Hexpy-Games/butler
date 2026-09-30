//! F/G/M/N. Profile, projects, attachments, queued messages
//! (SCENARIOS.md PRO-01, PRJ-01, ATT-01, Q-01, Q-02).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::media;
use butler_e2e::e2e::provider::Pacing;
use butler_e2e::e2e::scenario::{Scenario, Setup, accepted_turn_id};
use serde_json::{Value, json};

const LONG: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

/// PRO-01 — Profile read/write through HTTP and CLI, persisted.
#[tokio::test]
async fn pro_01_personalization_read_write() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PRO-01")?.start().await?;
    let marker = butler_e2e::e2e::nonce();
    let reply = s
        .gw
        .patch(
            "/personalization",
            json!({"response_language": "ko", "eol": format!("Sign off with {marker}."), "profile": {"principal_name": marker}}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let view = s.gw.get("/personalization").await?;
    assert_eq!(view.data()["response_language"], "ko");
    assert!(
        view.data()["eol"]
            .as_str()
            .unwrap_or_default()
            .contains(&marker)
    );
    // The CLI shows the profile part of personalization.
    let cli = s.agent.cli(&["personalization", "get", "--json"])?;
    assert_eq!(cli.code, Some(0), "{} {}", cli.stdout, cli.stderr);
    assert_eq!(
        cli.json()?["data"]["profile"]["principal_name"],
        marker.as_str(),
        "CLI disagrees with HTTP"
    );

    let before = s.gw.get("/personalization").await?.data().clone();
    let rejected =
        s.gw.patch("/personalization", json!({"no_such_field": 1}))
            .await?;
    assert_eq!(rejected.status, 400, "{}", rejected.text);
    let rejected =
        s.gw.patch("/personalization", json!({"response_language": "fr"}))
            .await?;
    assert_eq!(rejected.status, 400, "{}", rejected.text);
    let mut after = s.gw.get("/personalization").await?.data().clone();
    after["updated_at"] = before["updated_at"].clone();
    assert_eq!(after, before, "rejected update changed the profile");

    s.restart().await?;
    let view = s.gw.get("/personalization").await?;
    assert_eq!(view.data()["response_language"], "ko");
    assert!(
        view.data()["eol"]
            .as_str()
            .unwrap_or_default()
            .contains(&marker)
    );
    s.finish().await
}

/// PRJ-01 — Project lifecycle: create, pin, archive, navigation, restart.
#[tokio::test]
async fn prj_01_project_lifecycle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PRJ-01")?.start().await?;
    let name = format!("E2E {}", &butler_e2e::e2e::nonce()[..6]);
    let created =
        s.gw.post(
            "/projects",
            json!({"source": "scratch", "display_name": name}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let pin =
        s.gw.post(&format!("/projects/{id}/pin"), json!({"pinned": true}))
            .await?;
    assert_eq!(pin.status, 200, "{}", pin.text);
    let find = |projects: &Value| {
        projects["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|project| project["id"] == id.as_str())
            .cloned()
    };
    let listed = find(s.gw.get("/projects").await?.data()).expect("project listed");
    assert_eq!(listed["display_name"], name.as_str());
    assert_eq!(listed["pinned"], true);
    let navigation = s.gw.get("/navigation").await?;
    assert!(
        navigation.text.contains(&id),
        "project missing from navigation"
    );

    let archive =
        s.gw.post(&format!("/projects/{id}/archive"), json!({}))
            .await?;
    assert_eq!(archive.status, 200, "{}", archive.text);
    let invalid = s.gw.post("/projects", json!({"source": "scratch"})).await?;
    assert_eq!(invalid.status, 400, "{}", invalid.text);
    let outside =
        s.gw.post(
            "/projects",
            json!({"source": "existing_folder", "folder_selection_token": "/etc"}),
        )
        .await?;
    assert!(
        (400..500).contains(&outside.status),
        "raw path accepted as folder token: {}",
        outside.text
    );

    s.restart().await?;
    let all = s.gw.get("/projects?include_archived=true").await?;
    let after = find(all.data()).or_else(|| find(&json!({"projects": s_archives(&all)})));
    if let Some(after) = after {
        assert_eq!(after["archived"], true, "{after}");
    } else {
        let archives = s.gw.get("/archives").await?;
        assert!(
            archives.text.contains(&id),
            "archived project lost: {}",
            archives.text
        );
    }
    s.finish().await
}

fn s_archives(reply: &butler_e2e::e2e::gateway::Reply) -> Value {
    reply.data()["archived_projects"].clone()
}

/// ATT-01 — Upload, attach, download hash-identical, survive restart; bad
/// uploads rejected without orphan files.
#[tokio::test]
async fn att_01_upload_and_attach() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("ATT-01")?.start().await?;
    let png = media::digits_png("2718", 6);
    let text = format!("attachment {}\n", butler_e2e::e2e::nonce()).into_bytes();
    let mut ids = Vec::new();
    for (name, mime, bytes) in [
        ("n.png", "image/png", png.clone()),
        ("note.txt", "text/plain", text.clone()),
    ] {
        let reply = s.gw.upload(name, mime, &bytes, Some("general")).await?;
        assert_eq!(reply.status, 201, "{name}: {}", reply.text);
        ids.push((
            reply.data()["file"]["file_id"].as_str().unwrap().to_owned(),
            bytes,
        ));
    }
    for (id, bytes) in &ids {
        let (status, downloaded) = s.gw.download(&format!("/message-files/{id}")).await?;
        assert_eq!(status, 200);
        assert_eq!(
            media::sha256(&downloaded),
            media::sha256(bytes),
            "download differs"
        );
    }
    let files_before = count_files(&s.sandbox.data);
    let oversize = vec![b'a'; 10 * 1024 * 1024 + 16];
    let reply =
        s.gw.upload("big.txt", "text/plain", &oversize, Some("general"))
            .await?;
    assert!(
        (400..500).contains(&reply.status),
        "oversize accepted: {}",
        reply.status
    );
    let reply =
        s.gw.upload(
            "tool.exe",
            "application/x-msdownload",
            b"MZ\x90\x00",
            Some("general"),
        )
        .await?;
    assert!(
        (400..500).contains(&reply.status),
        "disallowed type accepted: {}",
        reply.text
    );
    let (status, _) = s.gw.download("/message-files/file-does-not-exist").await?;
    assert!((400..500).contains(&status), "unknown id: {status}");
    assert_eq!(
        count_files(&s.sandbox.data),
        files_before,
        "rejected uploads left files"
    );
    let unknown = s
        .gw
        .post("/messages", json!({"chat_id": "general", "text": "see file", "attachments": [{"file_id": "file-unknown"}],
            "client_message_id": uuid::Uuid::new_v4().to_string()}))
        .await?;
    assert!(
        (400..500).contains(&unknown.status),
        "unknown attachment accepted: {}",
        unknown.text
    );

    s.restart().await?;
    for (id, bytes) in &ids {
        let (status, downloaded) = s.gw.download(&format!("/message-files/{id}")).await?;
        assert_eq!(status, 200, "file {id} lost across restart");
        assert_eq!(media::sha256(&downloaded), media::sha256(bytes));
    }
    s.finish().await
}

fn count_files(dir: &std::path::Path) -> usize {
    let mut count = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = path.to_string_lossy();
            if name.contains("/logs")
                || name.ends_with(".log")
                || name.contains("sqlite")
                || name.contains("/metrics")
            {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else {
                count += 1;
            }
        }
    }
    count
}

async fn enqueue(s: &Scenario, text: &str) -> Result<String, HarnessError> {
    let reply = s
        .gw
        .post("/session-queue", json!({"chat_id": "general", "text": text, "client_message_id": uuid::Uuid::new_v4().to_string()}))
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let queued = reply.data()["queued_messages"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .rev()
                .find(|item| item["text"] == text)
                .cloned()
        })
        .or_else(|| Some(reply.data()["queued"].clone()))
        .unwrap_or_default();
    Ok(queued["id"].as_str().unwrap_or_default().to_owned())
}

async fn queue(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let reply = s.gw.get("/session-queue?chat_id=general").await?;
    Ok(reply.data()["queued_messages"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

async fn start_slow_turn(s: &Scenario) -> Result<String, HarnessError> {
    if !s.recording() {
        s.provider()?.set_pacing(Pacing {
            scale: 1.0,
            cap_ms: 300,
            min_ms: 200,
        });
    }
    let accepted = s.gw.say("general", LONG).await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline, "provider not reached");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(turn_id)
}

/// Q-01 — Queue while busy: edit, delete, then in-order exactly-once runs.
#[tokio::test]
async fn q_01_queue_while_busy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("Q-01")?.cassette("Q-01").start().await?;
    let running = start_slow_turn(&s).await?;
    let first = enqueue(&s, "Reply with exactly the word: first").await?;
    let second = enqueue(&s, "Reply with exactly the word: second").await?;
    let third = enqueue(&s, "Reply with exactly the word: third").await?;
    let edit =
        s.gw.patch(
            &format!("/session-queue/{second}"),
            json!({"text": "Reply with exactly the word: edited"}),
        )
        .await?;
    assert_eq!(edit.status, 200, "{}", edit.text);
    let delete = s.gw.delete(&format!("/session-queue/{third}")).await?;
    assert_eq!(delete.status, 200, "{}", delete.text);
    let texts: Vec<String> = queue(&s)
        .await?
        .iter()
        .filter_map(|item| item["text"].as_str().map(str::to_owned))
        .collect();
    assert!(
        texts.iter().any(|t| t.contains("edited")) && !texts.iter().any(|t| t.contains("third")),
        "{texts:?}"
    );
    let _ = first;

    s.gw.wait_terminal("general", &running, Duration::from_secs(120))
        .await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.len() >= 3 && turns.iter().all(|turn| turn_state(turn) == "delivered") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queued items did not all run: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let users: Vec<String> =
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["role"] == "user")
            .filter_map(|m| m["text"].as_str().map(str::to_owned))
            .collect();
    assert_eq!(users.len(), 3, "{users:?}");
    assert!(
        users[1].contains("first") && users[2].contains("edited"),
        "wrong order: {users:?}"
    );
    assert!(
        !users.iter().any(|t| t.contains("third")),
        "deleted item ran"
    );
    s.finish().await
}

/// Q-02 — Queue durability and conflicts: a replayed client id adds no
/// entry, a changed body conflicts, and the queued message survives a
/// restart and runs exactly once.
#[tokio::test]
async fn q_02_queue_durability_and_conflicts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("Q-02")?.cassette("Q-02").start().await?;
    let running = start_slow_turn(&s).await?;
    let client = uuid::Uuid::new_v4().to_string();
    let body = json!({"chat_id": "general", "text": "Reply with exactly the word: waiting", "client_message_id": client});
    let reply = s.gw.post("/session-queue", body.clone()).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let replay = s.gw.post("/session-queue", body).await?;
    assert!(replay.status < 300, "{}", replay.text);
    assert_eq!(
        queue(&s).await?.len(),
        1,
        "replayed client id duplicated the entry"
    );
    let conflict =
        s.gw.post(
            "/session-queue",
            json!({"chat_id": "general", "text": "changed", "client_message_id": client}),
        )
        .await?;
    assert!(
        (400..500).contains(&conflict.status),
        "changed body accepted: {}",
        conflict.text
    );

    s.restart().await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        s.supervise().await?;
        let turns = s.gw.turns("general").await?;
        let settled = turns
            .iter()
            .all(|turn| butler_e2e::e2e::gateway::TERMINAL.contains(&turn_state(turn)));
        // A message the restart interrupted stays listed as failed and
        // retryable (an announced stop drains for 6 s at most); drained
        // means nothing is still waiting.
        let waiting = queue(&s)
            .await?
            .iter()
            .any(|item| item["state"] == "queued");
        if settled && !waiting && turns.len() >= 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queue did not drain after restart: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let waiting =
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| {
                m["role"] == "user" && m["text"].as_str().is_some_and(|t| t.contains("waiting"))
            })
            .count();
    assert_eq!(waiting, 1, "queued message ran {waiting} times");
    let _ = running;
    s.finish().await
}

/// ATT-01 (image) — a PNG attached for a model whose catalog entry says
/// `image_input_support: supported` is admitted (checked before any model call).
#[tokio::test]
async fn att_01_image_attachment_admitted_for_image_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ATT-01-IMAGE")?.start().await?;
    let png = media::digits_png("4821", 12);
    let upload =
        s.gw.upload("number.png", "image/png", &png, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let file_id = upload.data()["file"]["file_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let reply = s
        .gw
        .post(
            "/messages",
            json!({"chat_id": "general", "text": "What number is this?", "attachments": [{"file_id": file_id}],
                "client_message_id": uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    s.finish().await
}
