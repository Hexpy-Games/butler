use super::*;
use crate::gateway::application::{read_model, storage::AppStorage};

async fn storage() -> (AppStorage, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!("partial-{}.sqlite", uuid::Uuid::new_v4()));
    let storage = AppStorage::open(path.clone(), None, "now".into())
        .await
        .unwrap();
    storage.execute(|db| {
        db.execute("INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES('turn','general','streaming','Streaming','now','now')", []).map_err(AppStorageError::sqlite)?;
        db.execute("INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) VALUES('draft','general','turn','assistant','Partial','streaming','now','now')", []).map_err(AppStorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    (storage, path)
}

async fn kept_partial_uses_main_status_and_exposes_incomplete() {
    let (storage, path) = storage().await;
    storage
        .execute(|db| {
            stream_message::incomplete(
                db,
                &EventSubscribers::default(),
                "general",
                "turn",
                "later",
            )?;
            let status: String = db
                .query_row("SELECT status FROM messages WHERE id='draft'", [], |r| {
                    r.get(0)
                })
                .map_err(AppStorageError::sqlite)?;
            // Pinned origin/main MessageStatus wire values, so rollback can parse this row.
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "snake_case")]
            enum MainMessageStatus {
                Pending,
                Sent,
                Thinking,
                Streaming,
                Delivered,
                Failed,
                Retrying,
                Cancelled,
            }
            let _: MainMessageStatus = serde_json::from_value(json!(status)).unwrap();
            let message = read_model::exact_message(db, "general", "draft")?.unwrap();
            assert_eq!(message.incomplete, Some(true));
            assert!(matches!(
                message.status,
                crate::gateway::MessageStatus::Cancelled
            ));
            assert_eq!(message.text, "Partial");
            assert!(message.safe_error_code.is_none());
            Ok(())
        })
        .await
        .unwrap();
    storage.close().await.unwrap();
    std::fs::remove_file(path).unwrap();
}

async fn empty_stop_draft_keeps_main_cancelled_bubble() {
    let (storage, path) = storage().await;
    storage.execute(|db| {
        db.execute("UPDATE messages SET text='' WHERE id='draft'", []).map_err(AppStorageError::sqlite)?;
        db.execute("INSERT INTO turn_stream_drafts(turn_id,stream_id,discarded,updated_at) VALUES('turn','stream',0,'now')", []).map_err(AppStorageError::sqlite)?;
        operations::project_cancelled(db, &EventSubscribers::default(), "general", "turn", &Map::new(), "later", "cancel")?;
        let message = read_model::exact_message(db, "general", "draft")?.unwrap();
        assert_eq!(message.text, "");
        assert!(matches!(message.status, crate::gateway::MessageStatus::Cancelled));
        assert_eq!(message.safe_error_code.as_deref(), Some("turn_stopped"));
        assert_eq!(message.incomplete, None);
        let deleted: i64 = db.query_row("SELECT COUNT(*) FROM events WHERE type='message.deleted'", [], |r| r.get(0)).map_err(AppStorageError::sqlite)?;
        assert_eq!(deleted, 0);
        Ok(())
    }).await.unwrap();
    storage.close().await.unwrap();
    std::fs::remove_file(path).unwrap();
}

async fn null_retry_mode_from_old_build_is_derived_after_upgrade() {
    let (storage, path) = storage().await;
    storage
        .execute(|db| {
            db.execute_batch(
                "PRAGMA user_version=2; UPDATE messages SET status='failed',retry_mode=NULL;",
            )
            .map_err(AppStorageError::sqlite)?;
            for (code, retryable, resume, current) in [
                ("runtime_fault", true, true, true),
                ("turn_interrupted", true, true, false),
                ("runtime_fault", false, false, false),
                ("provider_network_error", true, false, false),
            ] {
                db.execute(
                    "UPDATE messages SET safe_error_code=?1,retryable=?2 WHERE id='draft'",
                    params![code, retryable],
                )
                .map_err(AppStorageError::sqlite)?;
                let message = read_model::exact_message(db, "general", "draft")?.unwrap();
                assert_eq!(message.retry_mode.is_some(), resume, "{code}");
                if resume {
                    assert!(matches!(
                        message.retry_mode,
                        Some(crate::gateway::protocol::RetryMode::Resume)
                    ));
                }
                assert_eq!(message.retry_with_current_controls, current, "{code}");
            }
            let persisted: Option<String> = db
                .query_row(
                    "SELECT retry_mode FROM messages WHERE id='draft'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            assert!(persisted.is_none(), "derivation must not write back");
            Ok(())
        })
        .await
        .unwrap();
    storage.close().await.unwrap();
    std::fs::remove_file(path).unwrap();
}

async fn tool_batch_without_progress_prevents_fresh_retry() {
    let (storage, path) = storage().await;
    storage.execute(|db| {
        let subscribers = EventSubscribers::default();
        let metadata = json!({"event":{"kind":"turn.tool_batch.recorded","visibility":"internal","payload":{}}});
        project_runtime_event(RuntimeInput { db, subscribers: &subscribers, chat: "general", turn: "turn",
            metadata: metadata.as_object().unwrap(), message: &Map::new(), now: "later", generated_id: "batch" })?;
        let work: bool = db.query_row("SELECT tool_work_recorded FROM turns WHERE id='turn'", [], |r|r.get(0)).map_err(AppStorageError::sqlite)?;
        assert!(work);
        let metadata = json!({"safeErrorCode":"provider_network_error"});
        operations::project_failed(db, &subscribers, "general", "turn", FailedProjection {
            metadata: metadata.as_object().unwrap(), message: &Map::new(), retryable: true,
        }, "later", &ProjectionIds {event_id:"failure-event".into(),message_id:"failure".into()})?;
        let failure = read_model::exact_message(db, "general", "failure")?.unwrap();
        assert!(!failure.retryable);
        assert!(failure.retry_mode.is_none());
        assert!(!failure.retry_with_current_controls);
        let progress: i64 = db.query_row("SELECT COUNT(*) FROM events WHERE type='progress.summary'", [], |r|r.get(0)).map_err(AppStorageError::sqlite)?;
        assert_eq!(progress, 0);
        Ok(())
    }).await.unwrap();
    storage.close().await.unwrap();
    std::fs::remove_file(path).unwrap();
}

async fn unanswered_failure_drops_empty_draft_and_uses_app_locale() {
    let (storage, path) = storage().await;
    storage.execute(|db| {
        for (locale, expected) in [("ko", "표시할 답변이 없습니다."), ("en", "No visible answer.")] {
            db.execute("DELETE FROM messages WHERE id<>'draft'", []).map_err(AppStorageError::sqlite)?;
            db.execute("INSERT OR REPLACE INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) VALUES('draft','general','turn','assistant','','streaming','now','now')", []).map_err(AppStorageError::sqlite)?;
            stream_message::fail_unanswered(db, &EventSubscribers::default(), "general", "turn", "later", locale)?;
            let page = read_model::list_messages(db, "general", 0.0, 200)?;
            assert_eq!(page.messages.len(), 1);
            let failure = &page.messages[0];
            assert_eq!(failure.safe_error_code.as_deref(), Some("no_visible_result"));
            assert_eq!(failure.text, expected);
            assert!(matches!(failure.status, crate::gateway::MessageStatus::Failed));
        }
        Ok(())
    }).await.unwrap();
    storage.close().await.unwrap();
    std::fs::remove_file(path).unwrap();
}

/// Persisted terminal rows and their projected public messages stay consistent.
pub(in crate::gateway::application) async fn assert_terminal_projection_contracts() {
    kept_partial_uses_main_status_and_exposes_incomplete().await;
    empty_stop_draft_keeps_main_cancelled_bubble().await;
    null_retry_mode_from_old_build_is_derived_after_upgrade().await;
    tool_batch_without_progress_prevents_fresh_retry().await;
    unanswered_failure_drops_empty_draft_and_uses_app_locale().await;
}
