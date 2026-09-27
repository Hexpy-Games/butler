use super::*;

#[tokio::test]
async fn opens_pre_origin_schema_additively_and_keeps_unknown_columns() {
    let path = test_path("old-schema");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE conversation_messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, seq INTEGER NOT NULL,
          role TEXT NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL,
          provenance TEXT NOT NULL, created_at TEXT NOT NULL, compacted_by_summary_id TEXT,
          source_gateway TEXT, source_ref TEXT, legacy_extension TEXT,
          UNIQUE (session_id, seq)
        );",
    )
    .unwrap();
    db.close().unwrap();
    let (store, _, _) = open_at(path.clone()).await;
    let columns = store
        .execute(|db| {
            let mut statement = db
                .prepare("SELECT name FROM pragma_table_info('conversation_messages')")
                .map_err(ConversationError::sqlite)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(ConversationError::sqlite)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(ConversationError::sqlite)
        })
        .await
        .unwrap();
    assert!(columns.contains(&"legacy_extension".to_owned()));
    assert!(columns.contains(&"origin_kind".to_owned()));
    assert!(columns.contains(&"origin_evidence_json".to_owned()));
    store.close().await.unwrap();
    let _ignored_cleanup = std::fs::remove_file(path);
}

#[tokio::test]
async fn cancelled_first_close_observer_does_not_own_drain_completion() {
    let path = test_path("close");
    let (store, _, _) = open_at(path.clone()).await;
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let operation_store = store.clone();
    let operation = tokio::spawn(async move {
        operation_store
            .execute(move |_| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .await
    });
    tokio::task::spawn_blocking(move || started_rx.recv_timeout(Duration::from_secs(2)).unwrap())
        .await
        .unwrap();
    let first_store = store.clone();
    let first = tokio::spawn(async move { first_store.close().await });
    tokio::task::yield_now().await;
    first.abort();
    release_tx.send(()).unwrap();
    operation.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(2), store.close())
        .await
        .unwrap()
        .unwrap();
    let _ignored_cleanup = std::fs::remove_file(path);
}
