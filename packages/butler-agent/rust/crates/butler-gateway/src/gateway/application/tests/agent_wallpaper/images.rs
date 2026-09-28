//! Image sources through the agent route, and its overview.

use super::*;

#[tokio::test]
async fn attachments_are_promoted_once_and_images_default_to_a_readable_dim() {
    let fixture = open("agent-attachment").await;
    let photo = attach(&fixture, "photo.png", "image/png", white()).await;
    let change = set(
        &fixture,
        global(json!({"kind": "image_from_attachment", "attachment_id": photo})),
    )
    .await;
    let asset = change.next["asset"].as_str().unwrap().to_owned();
    assert!(asset.starts_with("wp_"), "{asset}");
    assert_eq!(
        change.next,
        json!({"kind": "image", "fit": "cover", "blur": 0, "dim": 0.4, "asset": asset})
    );
    assert_eq!(global_source(&fixture).await, change.next);

    let id = create_project(&fixture, "Atlas").await;
    let again = json!({"kind": "image_from_attachment", "attachment_id": photo, "fit": "contain", "dim": 0.1});
    let reused = set(&fixture, project(&id, again)).await;
    assert_eq!(reused.next["asset"], json!(asset));
    assert_eq!(reused.next["dim"], json!(0.1));
    assert_eq!(fixture.app.list_wallpapers().await.unwrap().len(), 1);

    let upload = fixture.upload(8, 8).await;
    let by_id = set(
        &fixture,
        global(json!({"kind": "image", "asset": upload.id})),
    )
    .await;
    assert_eq!(
        by_id.next["dim"],
        json!(crate::gateway::application::wallpapers::default_dim_for(
            upload.luminance
        ))
    );

    let notes = attach(
        &fixture,
        "notes.txt",
        "text/plain",
        Bytes::from_static(b"notes"),
    )
    .await;
    let text = reject(
        &fixture,
        global(json!({"kind": "image_from_attachment", "attachment_id": notes})),
    )
    .await;
    assert_eq!(
        (text.status, text.code.as_str(), text.field.as_str()),
        (415, "wallpaper_unsupported_type", "source.attachment_id")
    );
    let unknown = json!({"kind": "image_from_attachment", "attachment_id": "file-00000000-0000-4000-8000-000000000999"});
    let unknown = reject(&fixture, global(unknown)).await;
    assert_eq!(
        (unknown.code.as_str(), unknown.field.as_str()),
        ("message_file_not_found", "source.attachment_id")
    );
    let blank = reject(&fixture, global(json!({"kind": "image_from_attachment"}))).await;
    assert_eq!(blank.field, "source.attachment_id");
    assert_eq!(fixture.app.list_wallpapers().await.unwrap().len(), 2);
    fixture.close().await;
}

#[test]
fn default_dim_matches_the_ui_readability_default() {
    let dim = crate::gateway::application::wallpapers::default_dim_for;
    for (luminance, expected) in [
        (0.0, 0.0),
        (0.2, 0.0),
        (0.5, 0.2),
        (0.8, 0.35),
        (0.83, 0.4),
        (1.0, 0.4),
    ] {
        assert_eq!(dim(luminance), expected, "{luminance}");
    }
    assert_eq!(dim(f64::NAN), 0.2);
}

#[tokio::test]
async fn overview_lists_the_settings_project_modules_and_images() {
    let fixture = open("agent-overview").await;
    let upload = fixture.upload(8, 8).await;
    let overview = fixture.app.wallpaper_overview(None).await.unwrap();
    let legacy: Value = serde_json::from_str(LEGACY_DEFAULT).unwrap();
    assert_eq!(overview["global"]["source"], legacy);
    assert_eq!(overview["global"]["motion"], json!("auto"));
    let ids: Vec<_> = overview["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].clone())
        .collect();
    for id in ["butler.bloom", "butler.grain", "butler.silk"] {
        assert!(ids.contains(&json!(id)), "{ids:?}");
    }
    assert!(!ids.contains(&json!("butler.image")), "{ids:?}");
    assert_eq!(
        overview["images"],
        json!([{"id": upload.id, "width": 8, "height": 8, "luminance": upload.luminance, "color": upload.color}])
    );
    assert!(overview.get("project").is_none());

    let id = create_project(&fixture, "Atlas").await;
    let overview = fixture
        .app
        .wallpaper_overview(Some(id.clone()))
        .await
        .unwrap();
    assert_eq!(
        overview["project"],
        json!({"id": id, "wallpaper": "inherit", "effective": legacy})
    );
    let error = fixture
        .app
        .wallpaper_overview(Some("nowhere".into()))
        .await
        .unwrap_err();
    assert_eq!(public_code(error).1, "project_not_found");
    // The agent's entries are the listing's plus how each module is used.
    let described = overview["modules"].as_array().unwrap();
    let uses = |id: &str| {
        let entry = described.iter().find(|entry| entry["id"] == id).unwrap();
        entry["uses"].clone()
    };
    assert_eq!(uses("butler.bloom"), json!(["live"]));
    assert_eq!(uses("butler.grain"), json!(["filter"]));
    let listed: Vec<Value> = described
        .iter()
        .map(|entry| {
            let mut entry = entry.clone();
            for flag in ["uses", "photo", "realtimeParam"] {
                entry.as_object_mut().unwrap().remove(flag);
            }
            entry
        })
        .collect();
    assert_eq!(fixture.app.wallpaper_modules().await.unwrap(), listed);
    fixture.close().await;
}
