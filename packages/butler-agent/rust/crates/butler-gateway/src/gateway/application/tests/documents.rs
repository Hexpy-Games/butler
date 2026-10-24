//! Document snapshots share the exact queued input's retry lifetime.
use super::*;

pub(super) async fn assert_retry_snapshot(app: &AppApplication, turn_id: &str) {
    let turn_id = turn_id.to_owned();
    app.storage
        .execute(move |db| {
            let mut tx = db.savepoint().map_err(AppStorageError::sqlite)?;
            let db = &tx;
            let queued: String = db
                .query_row(
                    "SELECT id FROM session_queued_messages WHERE turn_id=?1",
                    [&turn_id],
                    |row| row.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            db.execute(
                "UPDATE session_queued_messages SET control_resolution_json=NULL WHERE id=?1",
                [&queued],
            )
            .map_err(AppStorageError::sqlite)?;
            db.execute(
                "DELETE FROM session_queued_document_edits WHERE queued_id=?1",
                [&queued],
            )
            .map_err(AppStorageError::sqlite)?;
            let subscribers = events::EventSubscribers::default();
            let document = super::super::documents::run(
                db,
                AppDocumentCommand::Create(
                    json!({"title":"Notes","body":"Before","author":"user","chat_id":"general"}),
                ),
                &subscribers,
            )?;
            let claim: String = db
                .query_row(
                    "SELECT claim_id FROM session_queued_messages WHERE id=?1",
                    [&queued],
                    |row| row.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            let first = super::super::snapshot_input::claimed_input(db, &queued, &claim)?.3;
            assert_eq!(first.len(), 1);
            assert!(first[0].contains("+Before"));
            let retry_claim = format!("{claim}-retry");
            db.execute(
                "UPDATE session_queued_messages SET claim_id=?2 WHERE id=?1",
                rusqlite::params![queued, retry_claim],
            )
            .map_err(AppStorageError::sqlite)?;
            let retried = super::super::snapshot_input::claimed_input(db, &queued, &retry_claim)?.3;
            assert_eq!(
                retried, first,
                "a retried claim keeps its admitted edits after seen advances"
            );
            let resolution: Option<String> = db
                .query_row(
                    "SELECT control_resolution_json FROM session_queued_messages WHERE id=?1",
                    [&queued],
                    |row| row.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            assert_eq!(resolution, None);
            assert!(document["id"].is_string());
            db.execute("DELETE FROM session_queued_messages WHERE id=?1", [&queued])
                .map_err(AppStorageError::sqlite)?;
            let retained: i64 = db
                .query_row(
                    "SELECT count(*) FROM session_queued_document_edits WHERE queued_id=?1",
                    [&queued],
                    |row| row.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            assert_eq!(retained, 0, "queue deletion releases its context snapshot");
            tx.rollback().map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
}
