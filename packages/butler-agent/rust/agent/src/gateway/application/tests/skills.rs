use super::*;

#[tokio::test]
async fn session_view_and_summary_project_loaded_skills_for_the_latest_turn() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let root = std::env::temp_dir().join(format!(
        "butler-skills-view-{}",
        Clock(AtomicU64::new(89)).new_uuid()
    ));
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
    let mut app_dependencies = dependencies(native, 90);
    app_dependencies.skills =
        Arc::new(crate::skills::NativeSkills::new(root.clone(), root.clone()));
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
            project_workspace_root: root.clone(),
            folder_selection_secret: None,
        },
        app_dependencies,
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let sent = app
        .send_message(command("skills-view", "question"))
        .await
        .unwrap();
    let turn_id = sent.turn.unwrap().id;
    let loaded = json!({
        "eventId":"skills-loaded","sessionId":"butler/app-general","kind":"system",
        "timestamp":"2026-09-14T00:00:03.000Z",
        "payload":{"category":"context.skills.loaded","details":{
            "turnId":turn_id,"skillNames":[" used-skill ","used-skill","not a token"]
        }}
    });
    std::fs::write(
        root.join("transcripts/butler_app-general.jsonl"),
        format!("{loaded}\n"),
    )
    .unwrap();

    let view = app
        .session_view(
            "general".into(),
            AppSessionViewPage {
                after_cursor: None,
                before_cursor: None,
                limit: 20,
            },
        )
        .await
        .unwrap();
    let summary = app.session_summary_view("general".into()).await.unwrap();
    assert_eq!(view["skills_used"], json!(["used-skill"]));
    assert_eq!(summary["skills_used"], json!(["used-skill"]));
    app.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
