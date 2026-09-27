use super::*;

#[tokio::test]
async fn session_controls_view_inherits_then_patches_validated_controls() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let path = temp_path("session-controls-view");
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path.clone(),
            butler_data: path.parent().unwrap().into(),
            project_workspace_root: path.parent().unwrap().into(),
            folder_selection_secret: None,
        },
        dependencies(native, 300),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    app.send_message(command("session-controls-seed", "seed"))
        .await
        .unwrap();

    let inherited = app
        .get_session_controls_view_owned("general".into())
        .await
        .unwrap();
    assert_eq!(inherited.controls.model, "openai/gpt-test");
    assert_eq!(inherited.revision, 0);

    let updated = app
        .update_session_controls_view_owned(
            "general".into(),
            AppSessionControlUpdate {
                access_mode: Some("read_only".into()),
                plan_mode: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.controls.access_mode, "read_only");
    assert!(updated.controls.plan_mode);
    assert_eq!(updated.revision, 1);
    assert_eq!(updated.catalog_generation, "catalog-1");

    let error = app
        .update_session_controls_view_owned(
            "general".into(),
            AppSessionControlUpdate {
                model: Some("openai/missing".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GatewayApplicationError::Public {
            status: 409,
            ref code,
            ..
        } if code == "session_model_unavailable"
    ));
    let unchanged = app
        .get_session_controls_view_owned("general".into())
        .await
        .unwrap();
    assert_eq!(unchanged.revision, 1);
    assert_eq!(
        app.replay_events(0.0, 200)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.event_type == "session.controls_updated")
            .count(),
        1
    );
    app.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}
