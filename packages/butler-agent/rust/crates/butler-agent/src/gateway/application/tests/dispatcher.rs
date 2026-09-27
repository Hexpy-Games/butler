use super::*;

#[tokio::test]
async fn fifo_dispatcher_starts_next_message_after_terminal_wake() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let path = temp_path("fifo-dispatch");
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path.clone(),
            butler_data: path.parent().unwrap().into(),
            project_workspace_root: path.parent().unwrap().into(),
            folder_selection_secret: None,
        },
        dependencies(native.clone(), 200),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let first = app.send_message(command("fifo-1", "first")).await.unwrap();
    let second = app.send_message(command("fifo-2", "second")).await.unwrap();
    assert!(second.queued.is_some());
    assert_eq!(native.0.lock().unwrap().len(), 1);
    let turn = first.turn.unwrap().id;
    app.storage
        .execute(move |db| {
            db.execute(
                "UPDATE turns SET state='delivered',cancellable=0 WHERE id=?1",
                [&turn],
            )
            .map_err(AppStorageError::sqlite)?;
            db.execute(
                "UPDATE session_queued_messages SET state='dispatched',claim_id=NULL,\
                 claim_owner=NULL,claimed_at=NULL,lease_expires_at=NULL WHERE turn_id=?1",
                [&turn],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    app.queue_dispatcher
        .as_ref()
        .unwrap()
        .wake_chat("general".into())
        .await
        .unwrap();
    crate::testing::eventually("second queued message dispatch", || {
        native.0.lock().unwrap().len() == 2
    })
    .await;
    {
        let turns = native.0.lock().unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].text, "second");
    }
    app.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}
