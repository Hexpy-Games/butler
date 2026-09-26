use super::*;
use crate::gateway::GatewayApplication;

#[tokio::test]
async fn session_view_projects_progress_for_active_and_terminal_latest_turn() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let root =
        std::env::temp_dir().join(format!("butler-session-view-turn-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
            project_workspace_root: root.clone(),
            folder_selection_secret: None,
        },
        dependencies(native, 950),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let turn = app
        .send_message(command("session-view-turn", "question"))
        .await
        .unwrap()
        .turn
        .unwrap();
    let page = AppSessionViewPage {
        after_cursor: None,
        before_cursor: None,
        limit: 20,
    };

    let active_view = app
        .session_view("general".into(), page.clone())
        .await
        .unwrap();
    let active_turn = &active_view["active_turn"];
    assert_eq!(active_turn["progress"]["turn_id"], turn.id);
    assert_eq!(active_turn["progress"]["state"], active_turn["state"]);
    assert_eq!(
        active_turn["progress"]["updated_at"],
        active_turn["updated_at"]
    );

    let terminal_updated_at = "2026-09-14T00:00:02.000Z".to_owned();
    let terminal_updated_at_for_update = terminal_updated_at.clone();
    let retained_turn = turn.id.clone();
    let execution_model_json = serde_json::to_string(&json!({
        "requested_model_ref":"openai/requested",
        "adapter_effective_model_ref":"openai/effective",
        "provider_reported_model_ref":"openai/provider",
        "private_model_payload":"must not be projected"
    }))
    .unwrap();
    app.storage
        .execute(move |db| {
            let subscribers = EventSubscribers::default();
            events::append(
                db,
                &subscribers,
                "progress.summary",
                Some(&retained_turn),
                service::map(json!({
                    "session_id":"general",
                    "turn_id":retained_turn,
                    "row":{
                        "id":"session-view-work",
                        "kind":"used_tool",
                        "state":"completed",
                        "safe_label":"Read a file",
                        "safe_tool_name":"read_file",
                        "created_at":"2026-09-14T00:00:01.000Z"
                    }
                }))?,
                "2026-09-14T00:00:01.000Z",
            )?;
            db.execute(
                "UPDATE turns SET state='delivered',safe_status_label='Delivered',\
                 safe_error_code=NULL,retryable=0,cancellable=0,updated_at=?1,\
                 execution_model_json=?2 WHERE id=?3",
                rusqlite::params![
                    terminal_updated_at_for_update,
                    execution_model_json,
                    retained_turn
                ],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();

    let terminal_view = app.session_view("general".into(), page).await.unwrap();
    let latest_turn = &terminal_view["latest_turn"];
    let progress = &latest_turn["progress"];
    assert!(terminal_view["active_turn"].is_null());
    assert_eq!(latest_turn["id"], turn.id);
    assert_eq!(progress["turn_id"], turn.id);
    assert_eq!(progress["state"], "delivered");
    assert_eq!(progress["updated_at"], terminal_updated_at);
    assert_eq!(progress["safe_progress_rows"][0]["id"], "session-view-work");
    assert_eq!(
        progress["safe_progress_rows"][0]["safe_label"],
        "Read a file"
    );
    assert_eq!(latest_turn["delivery_state"], "delivered");
    assert_eq!(latest_turn["limitations"], json!([]));
    assert_eq!(latest_turn["limitation_codes"], json!([]));
    assert_eq!(latest_turn["safe_status_label"], "Delivered");

    let controls = &latest_turn["execution_controls"];
    assert!(controls["model_ref"].as_str().is_some());
    assert!(controls["reasoning_effort"].as_str().is_some());
    assert!(controls["source"].as_str().is_some());
    for private_field in [
        "schema_version",
        "turn_id",
        "session_id",
        "access_mode",
        "plan_mode",
        "session_control_revision",
        "catalog_generation",
        "resolved_at",
        "integrity_hash",
        "model_fallback",
    ] {
        assert!(controls.get(private_field).is_none(), "{private_field}");
    }
    assert_eq!(
        latest_turn["execution_model"],
        json!({
            "requested_model_ref":"openai/requested",
            "adapter_effective_model_ref":"openai/effective",
            "provider_reported_model_ref":"openai/provider"
        })
    );

    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
