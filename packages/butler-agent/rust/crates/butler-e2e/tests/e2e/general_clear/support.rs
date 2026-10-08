//! Synthetic scale and interrupted cross-store ownership fixtures.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::HarnessError;
use butler_platform::sqlite;
use rusqlite::{OpenFlags, params};
use std::path::Path;

pub(super) fn seed_scale(data: &Path) -> Result<(), HarnessError> {
    let mut db = sqlite::open_with_flags(
        data.join("app-server/butler-client.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    let tx = db.transaction()?;
    tx.execute_batch("INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,access_mode,state,last_run_state,created_at,updated_at) VALUES('kept-schedule','Kept schedule','Keep scheduling here','chat','general',3600,'full_access','paused','delivered','2026-01-01','2026-01-01'); INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,completed_at,turn_id) SELECT 'kept-run','kept-schedule','general','delivered','manual','2026-01-01','2026-01-01',id FROM turns WHERE chat_id='general' LIMIT 1")?;
    {
        let mut insert = tx.prepare("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES(?1,'general','user',?2,'delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")?;
        for row in 0..100_000 {
            insert.execute(params![
                format!("scale-{row:06}"),
                format!("Scale message {row:06}")
            ])?;
        }
    }
    tx.execute_batch("WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<7)
      INSERT INTO chats(id,title,kind,created_at,updated_at) SELECT 'small-'||i,'Small '||i,'chat','2026-01-01','2026-01-01' FROM n;
      INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at)
      SELECT 'message-'||id,id,'user','Small chat message','delivered','2026-01-01','2026-01-01' FROM chats WHERE id LIKE 'small-%';")?;
    // Large unrelated transport history forces the rare clear to scan without new write indexes.
    for table in [
        "projected_transport_events",
        "app_transport_projection_receipts",
    ] {
        tx.execute_batch(&format!("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<999999) INSERT INTO {table}(action_id,event_id,chat_id,created_at) SELECT 'scale-action-'||x,'scale-event-'||x||printf('%01200d',0),CASE WHEN x<100000 THEN 'general' ELSE 'other' END,'2026-01-01' FROM n"))?;
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn ordered_message_ids(
    db: &rusqlite::Connection,
    chat: &str,
) -> Result<Vec<String>, HarnessError> {
    let mut rows =
        db.prepare("SELECT id FROM app_owned_messages WHERE chat_id=?1 ORDER BY rowid")?;
    Ok(rows
        .query_map([chat], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn seed_interrupted_output_transfer(
    data: &Path,
    archive: &str,
) -> Result<(), HarnessError> {
    use sha2::{Digest, Sha256};
    let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO app_output_transfers VALUES(?1)", [archive])?;
    db.execute(
        "INSERT INTO app_session_context_gate VALUES('general','relocate',?1)",
        [archive],
    )?;
    // Manifest/outputs already moved; source markers and historical refs remain.
    let outputs = sqlite::open(data.join("outputs/index.sqlite"))?;
    outputs.execute(
        "UPDATE output_refs SET session='general' WHERE session=?1",
        [archive],
    )?;
    let root = data.join("outputs/sessions");
    std::fs::rename(
        root.join(format!("{:x}", Sha256::digest(archive.as_bytes()))),
        root.join(format!("{:x}", Sha256::digest(b"general"))),
    )?;
    Ok(())
}

pub(super) async fn verify_rotated_permissions(
    s: &butler_e2e::e2e::scenario::Scenario,
    archive: &str,
) -> Result<(), HarnessError> {
    super::super::authority_permissions::seed::seed(s.sandbox.data.clone(), 3, false).await?;
    let app = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let hint: String = app.query_row(
        "SELECT runtime_session_hint FROM chats WHERE id='general'",
        [],
        |r| r.get(0),
    )?;
    let btcc = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for (old, new) in [
        ("butler/app-chat-0", "butler/app-general"),
        ("butler/app-chat-1", hint.as_str()),
    ] {
        btcc.execute("UPDATE btcc_conversation_permissions SET owner_session_id=?2 WHERE owner_session_id=?1", params![old,new])?;
        btcc.execute(
            "UPDATE btcc_authority_requests SET owner_session_id=?2 WHERE owner_session_id=?1",
            params![old, new],
        )?;
    }
    let permissions = s.gw.get("/authority-permissions").await?;
    assert_eq!(permissions.status, 200, "{}", permissions.text);
    let grants = permissions.data()["permissions"].as_array().unwrap();
    assert_eq!(
        grants.iter().find(|g| g["session_id"] == hint).unwrap()["session_title"],
        "General"
    );
    let title: String = app.query_row("SELECT title FROM chats WHERE id=?1", [archive], |r| {
        r.get(0)
    })?;
    assert_eq!(
        grants
            .iter()
            .find(|g| g["session_id"] == "butler/app-general")
            .unwrap()["session_title"],
        title
    );
    Ok(())
}

/// Observe SQLite writer exclusion from a separate connection, including outer commit.
pub(super) struct WriteProbe {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    task: Option<tokio::task::JoinHandle<Result<std::time::Duration, HarnessError>>>,
}
impl WriteProbe {
    pub(super) async fn start(path: std::path::PathBuf) -> Result<Self, HarnessError> {
        let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.busy_timeout(std::time::Duration::ZERO)?;
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task = tokio::task::spawn_blocking(move || {
            use std::time::{Duration, Instant};
            let mut ready = Some(ready_tx);
            let mut available = Instant::now();
            let mut longest = Duration::ZERO;
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                let sample = Instant::now();
                match db.execute_batch("BEGIN IMMEDIATE; ROLLBACK") {
                    Ok(()) => {
                        longest = longest.max(available.elapsed());
                        available = sample;
                    }
                    Err(rusqlite::Error::SqliteFailure(error, _))
                        if error.code == rusqlite::ErrorCode::DatabaseBusy => {}
                    Err(error) => return Err(error.into()),
                }
                if let Some(sender) = ready.take() {
                    let _ = sender.send(());
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            // Include both sampling gaps around a reservation, rather than
            // undercounting a lock acquired between two probes.
            Ok(longest.max(available.elapsed()))
        });
        let probe = Self {
            stop,
            task: Some(task),
        };
        ready_rx.await.map_err(|e| HarnessError(e.to_string()))?;
        Ok(probe)
    }
    pub(super) async fn finish(mut self) -> Result<std::time::Duration, HarnessError> {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        self.task
            .take()
            .expect("probe task")
            .await
            .map_err(|e| HarnessError(e.to_string()))?
    }
}

impl Drop for WriteProbe {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Both cursor directions retain logical ownership and exact archive ordering.
pub(super) async fn verify_archive_cursors(
    s: &butler_e2e::e2e::scenario::Scenario,
    archive: &str,
) -> Result<(), HarnessError> {
    let latest =
        s.gw.get(&format!("/session-view?session_id={archive}&limit=1"))
            .await?;
    assert_eq!(latest.status, 200, "{}", latest.text);
    assert_eq!(latest.data()["messages"].as_array().unwrap().len(), 1);
    assert_eq!(latest.data()["messages"][0]["id"], "scale-099999");
    assert_eq!(latest.data()["messages"][0]["chat_id"], archive);
    assert_eq!(latest.data()["message_window"]["has_more"], true);
    let token = latest.data()["message_window"]["previous_cursor_token"]
        .as_str()
        .unwrap();
    let older =
        s.gw.get(&format!(
            "/session-view?session_id={archive}&limit=1&before_cursor_token={token}"
        ))
        .await?;
    assert_eq!(older.status, 200, "{}", older.text);
    assert_eq!(older.data()["messages"].as_array().unwrap().len(), 1);
    assert_eq!(older.data()["messages"][0]["id"], "scale-099998");
    assert_eq!(older.data()["messages"][0]["chat_id"], archive);
    let token = older.data()["message_window"]["next_cursor_token"]
        .as_str()
        .unwrap();
    let newer =
        s.gw.get(&format!(
            "/session-view?session_id={archive}&limit=1&cursor_token={token}"
        ))
        .await?;
    assert_eq!(newer.status, 200, "{}", newer.text);
    assert_eq!(newer.data()["messages"], latest.data()["messages"]);
    Ok(())
}

// Files are independent of the Browser gate and must survive every clear.
pub(super) fn verify_archived_outputs(
    before: &serde_json::Value,
    kept: &serde_json::Value,
    archive: &str,
) {
    let original = before["artifacts"].as_array().unwrap();
    let archived = kept["artifacts"].as_array().unwrap();
    assert_eq!(
        original.iter().filter(|a| a["file_id"].is_string()).count(),
        2
    );
    assert_eq!(archived.len(), original.len());
    for output in original {
        let moved = archived.iter().find(|a| a["id"] == output["id"]).unwrap();
        for field in [
            "kind",
            "file_id",
            "title",
            "size_bytes",
            "message_id",
            "turn_id",
        ] {
            assert_eq!(moved[field], output[field], "{field}");
        }
        assert_eq!(moved["session_id"], archive);
    }
}
