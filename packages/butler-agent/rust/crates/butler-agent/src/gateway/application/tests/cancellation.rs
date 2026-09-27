use super::*;

#[tokio::test]
async fn cancellation_returns_exact_turn_beyond_first_page() {
    let path = temp_path("cancel-exact-turn");
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path.clone(),
            butler_data: path.parent().unwrap().into(),
            project_workspace_root: path.parent().unwrap().into(),
            folder_selection_secret: None,
        },
        dependencies(Arc::new(Native(Mutex::new(Vec::new()))), 300),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    app.storage
        .execute(|db| {
            let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
            for index in 1..=205 {
                transaction
                    .execute(
                        "INSERT INTO turns(id,chat_id,state,safe_status_label,cancellable,created_at,updated_at) \
                         VALUES(?1,'general','thinking','Thinking',1,'now','now')",
                        [format!("cancel-turn-{index}")],
                    )
                    .map_err(AppStorageError::sqlite)?;
            }
            transaction.commit().map_err(AppStorageError::sqlite)
        })
        .await
        .unwrap();

    let response = app.cancel_turn("cancel-turn-205".into()).await.unwrap();
    assert_eq!(response["turn"]["id"], "cancel-turn-205");
    assert_eq!(response["turn"]["state"], "cancelling");
    app.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}
