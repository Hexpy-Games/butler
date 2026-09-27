use super::*;

fn controls_updated_events(events: &[crate::gateway::AppEventEnvelope]) -> usize {
    events
        .iter()
        .filter(|event| event.event_type == "session.controls_updated")
        .count()
}

/// A message's own controls apply to that message only (the session's
/// controls and revision stay unchanged), and a send replayed after its
/// dispatch lease expired reuses the message's durable resolution even when
/// the session's controls changed in between.
#[tokio::test]
async fn message_override_stays_per_message_and_replay_reuses_its_resolution() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let path = temp_path("controls");
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: path.clone(),
            butler_data: path.parent().unwrap().into(),
            project_workspace_root: path.parent().unwrap().into(),
            folder_selection_secret: None,
        },
        dependencies(native.clone(), 120),
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let mut request = command("controls-id", "same");
    request.request.plan_mode = Some(json!(true));
    app.send_message(request).await.unwrap();
    let session = app
        .get_session_controls_view_owned("general".into())
        .await
        .unwrap();
    assert_eq!(session.revision, 0, "the override became session controls");
    assert!(!session.controls.plan_mode);
    let patched = app
        .update_session_controls_view_owned(
            "general".into(),
            AppSessionControlUpdate {
                access_mode: Some("read_only".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(patched.revision, 1);
    app.storage
        .execute(|db| {
            db.execute(
                "UPDATE session_queued_messages SET lease_expires_at='2020-01-01T00:00:00.000Z'",
                [],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let mut replay = command("controls-id", "same");
    replay.request.plan_mode = Some(json!(true));
    app.send_message(replay).await.unwrap();
    {
        let turns = native.0.lock().unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].execution_controls["source"], "message_override");
        assert_eq!(
            turns[1].execution_controls, turns[0].execution_controls,
            "the replay resolved its controls again"
        );
    }
    let session = app
        .get_session_controls_view_owned("general".into())
        .await
        .unwrap();
    assert_eq!(session.revision, 1, "only the PATCH changed the session");
    assert_eq!(
        controls_updated_events(&app.replay_events(0.0, 200).await.unwrap()),
        1
    );
    app.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

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
