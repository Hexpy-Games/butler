use rusqlite::Connection;

use super::testing::Fixture;
use super::*;

// test-category: race
#[tokio::test]
async fn opener_cuts_over_an_r2_nonterminal_turn_without_reexecuting_it() {
    bootstrap::publication_regression();
    let fixture = Fixture::activated();
    {
        let connection = Connection::open(&fixture.path).expect("legacy fixture connection");
        schema::create_current(&connection).expect("current companion tables");
        connection
            .execute_batch(
                "DROP TABLE btcc_turns; \
                 CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, \
                 inbox_id TEXT NOT NULL UNIQUE, trigger_key TEXT NOT NULL, original_message_id TEXT NOT NULL, \
                 original_message TEXT NOT NULL, admission_snapshot_ref TEXT NOT NULL, \
                 model_selection_json TEXT NOT NULL, context_json TEXT NOT NULL, semantic_state TEXT NOT NULL, \
                 active_checkpoint_id TEXT, route TEXT, final_payload_json TEXT, delivery_outbox_id TEXT, \
                 canonical_assistant_message_id TEXT, revision INTEGER NOT NULL, execution_fence INTEGER NOT NULL, \
                 final_disposition TEXT); \
                 INSERT INTO btcc_turns VALUES ('legacy-turn', 'session-1', 'inbox-1', 'trigger-1', \
                 'message-1', 'continue the work', 'record-1', '{}', '{}', 'planning', NULL, NULL, NULL, \
                 NULL, NULL, 4, 2, NULL);",
            )
            .expect("legacy R2 Turn");
    }
    let storage = BtccStorage::open(fixture.config("owner-cutover"))
        .await
        .expect("open and cut over");
    let (state, revision, fence, disposition, outbox_status, evidence) = storage
        .execute(|connection| {
            let turn = connection
                .query_row(
                    "SELECT semantic_state, revision, execution_fence, final_disposition \
                     FROM btcc_turns WHERE turn_id = 'legacy-turn'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .map_err(StorageError::sqlite)?;
            let outbox_status = connection
                .query_row(
                    "SELECT status FROM btcc_delivery_outbox WHERE turn_id = 'legacy-turn'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::sqlite)?;
            let evidence = connection
                .query_row(
                    "SELECT evidence_json FROM btcc_r3_legacy_turn_cutovers \
                     WHERE turn_id = 'legacy-turn'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::sqlite)?;
            Ok((turn.0, turn.1, turn.2, turn.3, outbox_status, evidence))
        })
        .await
        .expect("cutover result");
    assert_eq!(state, "delivery_committed");
    assert_eq!(revision, 5);
    assert_eq!(fence, 3);
    assert_eq!(disposition, "completed");
    assert_eq!(outbox_status, "pending");
    assert!(evidence.contains("btcc.r3.legacy-turn-cutover.v2"));
    cancelled_reader_joins_on_close(storage).await;
}

async fn cancelled_reader_joins_on_close(storage: BtccStorage) {
    let reader = storage.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let query = tokio::spawn(async move {
        reader
            .read(move |db| {
                started.send(()).expect("query admitted");
                blocked.recv().expect("release cancelled read");
                assert_eq!(
                    db.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                        .expect("connection still open"),
                    1
                );
                Ok(())
            })
            .await
    });
    ready.await.expect("read started");
    query.abort();
    assert!(query.await.expect_err("caller cancelled").is_cancelled());
    let state = storage
        .read(|db| {
            db.query_row(
                "SELECT semantic_state FROM btcc_turns WHERE turn_id='legacy-turn'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(StorageError::sqlite)
        })
        .await
        .expect("other reader remains available");
    assert_eq!(state, "delivery_committed");
    let (started, ready) = tokio::sync::oneshot::channel();
    let closing = tokio::spawn(async move {
        started.send(()).expect("closing");
        storage.close().await
    });
    ready.await.expect("close started");
    assert!(
        !closing.is_finished(),
        "close must wait for the cancelled query"
    );
    release.send(()).expect("release read");
    closing
        .await
        .expect("close task")
        .expect("close owner and readers");
}
