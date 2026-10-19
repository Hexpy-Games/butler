use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) async fn generic_admission(s: &Scenario) -> Result<(), HarnessError> {
    for (content_type, length, status, code) in [
        ("text/plain", "2", 415, Some("unsupported_media_type")),
        ("application/json", "134217729", 413, None),
    ] {
        let address = format!("127.0.0.1:{}", s.agent.launch.port);
        let mut stream = tokio::net::TcpStream::connect(&address).await?;
        let request = format!(
            "POST /data/reset HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nX-Butler-Admin: {}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{{}}",
            s.gw.token,
            admin(s).admin,
        );
        stream.write_all(request.as_bytes()).await?;
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes))
            .await
            .expect("admission must reject without reading the declared body")?;
        let response = String::from_utf8(bytes).expect("HTTP response");
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(
            headers.starts_with(&format!("HTTP/1.1 {status} ")),
            "{response}"
        );
        if let Some(code) = code {
            let body: Value = serde_json::from_str(body).expect("JSON error");
            assert_eq!(body["error"]["code"], code, "{body}");
        } else {
            assert!(
                body.is_empty(),
                "generic size rejection has no error envelope"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn pending_cleanup_and_failed_intents_can_be_superseded() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for phase in ["applied", "failed"] {
        let mut s = setup("RESET-SUPERSEDE")?.start().await?;
        let before = generation(&s).await?;
        s.agent.terminate().await?;
        // Keep secret deletion pending explicitly; cache failure no longer blocks it.
        s.agent.launch.set_env(
            "BUTLER_TEST_SECRET_STORE",
            s.sandbox
                .root
                .join("unavailable-secrets/store.json")
                .display()
                .to_string(),
        );
        let root = &s.sandbox.data;
        let hot_cache = s.sandbox.workspace.join(".butler/hot-cache.md");
        // A nonempty directory makes cleanup fail without relying on OS keychain availability.
        std::fs::create_dir_all(&hot_cache)?;
        std::fs::write(hot_cache.join("pending"), b"pending")?;
        let keys = json!([{"service":"pending-service","account":"pending-account"}]);
        let journal = json!({
            "schema":1, "id":"previous-reset", "phase":phase,
            "created_at":"2026-10-18T00:00:00Z", "secret_keys":keys,
            "project_hot_caches":[hot_cache], "moves":[],
            "old_generation":before, "new_generation":before, "retried":false
        });
        let path = root.join("state/full-reset.json");
        if phase == "applied" {
            std::fs::write(&path, journal.to_string())?;
        }
        s.gw = s.agent.start_again().await?;
        if phase == "failed" {
            // Model the already-running process after an apply failed, before its next start.
            std::fs::write(&path, journal.to_string())?;
        }
        let accepted = request(&s, &nonce(&s).await?).await?;
        assert_eq!(accepted.status, 202, "{}", accepted.text);
        let next: Value = serde_json::from_slice(&std::fs::read(&path)?).unwrap();
        assert_eq!(next["phase"], "requested");
        assert_eq!(next["secret_keys"], keys);
        assert!(
            next["project_hot_caches"]
                .as_array()
                .unwrap()
                .contains(&json!(hot_cache))
        );
        s.agent.kill9()?;
        for name in [".reset-trash-older", ".reset-trash-another"] {
            std::fs::create_dir_all(s.sandbox.data.join(name))?;
            std::fs::write(s.sandbox.data.join(name).join("discard"), b"private")?;
        }
        let outside = s.sandbox.workspace.join("outside-trash");
        std::fs::create_dir_all(&outside)?;
        std::fs::write(outside.join("keep"), b"keep")?;
        let link = s.sandbox.data.join(".reset-trash-link");
        butler_platform::secure_fs::symlink(&outside, &link)?;
        s.gw = s.agent.start_again().await?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while s.sandbox.data.join(".reset-trash-older").exists()
            || s.sandbox.data.join(".reset-trash-another").exists()
        {
            assert!(Instant::now() < deadline, "older trash was not cleaned");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(std::fs::read(outside.join("keep"))?, b"keep");
        assert!(std::fs::symlink_metadata(link).is_err());
        assert_ne!(generation(&s).await?, before);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn durable_acceptance_survives_followup_storage_errors() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-ACCEPTANCE")?
        .env("BUTLER_E2E_RESET_STOP_DELAY_MS", "100")
        .start()
        .await?;
    let before = generation(&s).await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch(
        "INSERT INTO session_queued_messages(id,chat_id,text,controls_json,attachments_json,state,lease_expires_at,created_at,updated_at)
         VALUES('pending','general','pending','{}','[]','dispatching','9999-01-01T00:00:00Z','now','now');
         CREATE TRIGGER reject_reset_queue BEFORE UPDATE ON session_queued_messages
         WHEN NEW.safe_error_code='service_resetting' BEGIN SELECT RAISE(ABORT,'queue write fault'); END;
         CREATE TRIGGER reject_reset_event BEFORE INSERT ON events
         WHEN NEW.type='data.reset_started' BEGIN SELECT RAISE(ABORT,'event write fault'); END;",
    )?;
    drop(db);
    let accepted = request(&s, &nonce(&s).await?).await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    assert!(s.sandbox.data.join("state/full-reset.json").exists());
    let refused =
        s.gw.post("/messages", json!({"chat_id":"general","text":"blocked"}))
            .await?;
    assert_eq!(refused.status, 503);
    assert_eq!(refused.error_code(), Some("service_resetting"));
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "accepted reset did not stop");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    s.agent.terminate().await?;
    let logs = s.agent.logs();
    assert!(logs.contains("[full-reset] queue cancellation failed"));
    assert!(logs.contains("[full-reset] reset event publication failed"));
    s.gw = s.agent.start_again().await?;
    assert_ne!(generation(&s).await?, before);
    cleaned(&s.sandbox.data).await;
    s.finish().await
}
