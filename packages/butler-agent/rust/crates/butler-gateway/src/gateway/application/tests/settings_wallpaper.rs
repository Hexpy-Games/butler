use serde_json::Map;

use super::wallpapers::open;
use super::*;

async fn settings_updates(app: &AppApplication) -> Vec<Map<String, Value>> {
    app.replay_events(0.0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "settings.updated")
        .map(|event| event.payload)
        .collect()
}

const CUSTOM: [&str; 6] = [
    "#102030", "#405060", "#708090", "#a0b0c0", "#d0e0f0", "#010203",
];

#[tokio::test]
async fn settings_view_derives_wallpaper_from_the_legacy_defaults() {
    let fixture = open("wallpaper-default").await;
    let app = &fixture.app;
    let settings = app.worker_profile_settings().await.unwrap();
    assert_eq!(
        settings["wallpaper"],
        json!({
            "source": {"kind": "live", "module": "butler.bloom", "params": {"colors": "monochrome"}},
            "motion": "auto",
            "pauseOnBattery": false
        })
    );
    fixture.close().await;
}

#[tokio::test]
async fn legacy_patches_rederive_wallpaper_until_one_is_chosen() {
    let fixture = open("wallpaper-patch").await;
    let app = &fixture.app;
    let updated = app
        .update_settings_owned(json!({
            "main_screen_theme_preset": "custom",
            "main_screen_theme_custom_colors": CUSTOM,
        }))
        .await
        .unwrap();
    let custom = json!({"kind": "live", "module": "butler.bloom", "params": {"colors": CUSTOM}});
    assert_eq!(updated["wallpaper"]["source"], custom);
    let stored = app.worker_profile_settings().await.unwrap();
    assert_eq!(stored["wallpaper"]["source"], custom);
    let event = settings_updates(app).await.pop().unwrap();
    assert_eq!(event["settings"]["wallpaper"], updated["wallpaper"]);
    assert_eq!(
        event["settings"]["main_screen_theme_custom_colors"],
        json!(CUSTOM)
    );

    let asset = fixture.upload(8, 8).await.id;
    let wallpaper = json!({
        "source": {
            "kind": "image", "asset": asset, "fit": "contain", "dim": 0.4, "blur": 0.1,
            "filter": {"module": "butler.riso", "params": {"offset": 0.5}}
        },
        "motion": "paused",
        "pauseOnBattery": true
    });
    let updated = app
        .update_settings_owned(json!({"main_screen_theme": "silk", "wallpaper": wallpaper}))
        .await
        .unwrap();
    assert_eq!(updated["main_screen_theme"], "silk");
    assert_eq!(updated["wallpaper"], wallpaper);
    let stored = app.worker_profile_settings().await.unwrap();
    assert_eq!(stored["main_screen_theme"], "silk");
    assert_eq!(stored["wallpaper"], wallpaper);
    let event = settings_updates(app).await.pop().unwrap();
    assert_eq!(event["settings"]["wallpaper"], wallpaper);

    let updated = app
        .update_settings_owned(json!({"translucent_sidebar": false}))
        .await
        .unwrap();
    assert_eq!(updated["wallpaper"], wallpaper);
    // A legacy change never overwrites a wallpaper chosen through `wallpaper`.
    let updated = app
        .update_settings_owned(json!({"main_screen_theme": "none"}))
        .await
        .unwrap();
    assert_eq!(updated["main_screen_theme"], "none");
    assert_eq!(updated["wallpaper"], wallpaper);
    fixture.close().await;
}

#[tokio::test]
async fn invalid_wallpaper_is_rejected_without_a_settings_update() {
    let fixture = open("wallpaper-invalid").await;
    let app = &fixture.app;
    let before = app.worker_profile_settings().await.unwrap();
    let error = app
        .update_settings_owned(json!({
            "main_screen_theme": "silk",
            "wallpaper": {"source": {"kind": "live", "module": "butler.bloom", "params": {"Speed": 1}}}
        }))
        .await
        .unwrap_err();
    let GatewayApplicationError::Public {
        status,
        code,
        message,
        ..
    } = error
    else {
        panic!("expected a public error, got {error:?}");
    };
    assert_eq!((status, code.as_str()), (400, "settings_wallpaper_invalid"));
    assert!(
        message.contains("wallpaper.source.params"),
        "message should name the field: {message}"
    );
    assert_eq!(app.worker_profile_settings().await.unwrap(), before);
    assert!(settings_updates(app).await.is_empty());
    fixture.close().await;
}
