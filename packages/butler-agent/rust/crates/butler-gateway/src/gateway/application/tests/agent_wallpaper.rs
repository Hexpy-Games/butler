//! The agent's wallpaper route (`set_wallpaper` / `wallpaper_overview`) and
//! the `wallpaper.changed` event every wallpaper write emits.

use bytes::Bytes;
use image::{Rgba, RgbaImage};
use serde_json::Map;

use super::project_wallpaper::create_project;
use super::wallpapers::{Fixture, open, png, public_code};
use super::*;
use crate::gateway::{
    AppFileUpload, AppProjectDashboardPreferencesUpdate, AppWallpaperChange, AppWallpaperRejection,
    AppWallpaperScope, AppWallpaperSetRequest, GatewayWallpapers,
};

fn global(source: Value) -> AppWallpaperSetRequest {
    AppWallpaperSetRequest {
        scope: AppWallpaperScope::Global,
        project_id: None,
        source,
    }
}

fn project(id: &str, source: Value) -> AppWallpaperSetRequest {
    AppWallpaperSetRequest {
        scope: AppWallpaperScope::Project,
        project_id: Some(id.to_owned()),
        source,
    }
}

async fn set(fixture: &Fixture, request: AppWallpaperSetRequest) -> AppWallpaperChange {
    let source = request.source.clone();
    fixture
        .app
        .set_wallpaper(request)
        .await
        .unwrap()
        .unwrap_or_else(|rejection| panic!("{source}: {rejection:?}"))
}

async fn reject(fixture: &Fixture, request: AppWallpaperSetRequest) -> AppWallpaperRejection {
    fixture
        .app
        .set_wallpaper(request)
        .await
        .unwrap()
        .unwrap_err()
}

async fn events(fixture: &Fixture, kind: &str) -> Vec<Map<String, Value>> {
    fixture
        .app
        .replay_events(0.0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == kind)
        .map(|event| event.payload)
        .collect()
}

async fn global_source(fixture: &Fixture) -> Value {
    fixture.app.worker_profile_settings().await.unwrap()["wallpaper"]["source"].clone()
}

async fn attach(fixture: &Fixture, name: &str, mime: &str, bytes: Bytes) -> String {
    let upload = AppFileUpload {
        owner_session_id: None,
        name: name.into(),
        mime_type: Some(mime.into()),
        bytes,
    };
    fixture
        .app
        .upload_message_file(upload)
        .await
        .unwrap()
        .file_id
}

fn white() -> Bytes {
    png(&RgbaImage::from_pixel(64, 32, Rgba([255, 255, 255, 255])))
}

const LEGACY_DEFAULT: &str =
    r#"{"kind":"live","module":"butler.bloom","params":{"colors":"monochrome"}}"#;

#[tokio::test]
async fn agent_sets_the_global_wallpaper_reporting_previous_and_next() {
    let fixture = open("agent-global").await;
    let aurora = json!({"kind": "live", "module": "butler.bloom", "params": {"colors": "aurora"}});
    let change = set(&fixture, global(aurora.clone())).await;
    let legacy: Value = serde_json::from_str(LEGACY_DEFAULT).unwrap();
    assert_eq!(
        change,
        AppWallpaperChange {
            scope: AppWallpaperScope::Global,
            project_id: None,
            previous: legacy.clone(),
            next: aurora.clone(),
            changed: true,
        }
    );
    assert_eq!(global_source(&fixture).await, aurora);
    let settings = events(&fixture, "settings.updated").await;
    assert_eq!(
        settings.last().unwrap()["settings"]["wallpaper"]["source"],
        aurora
    );
    let changed = events(&fixture, "wallpaper.changed").await;
    assert_eq!(
        Value::Object(changed[0].clone()),
        json!({"scope": "global", "previous": legacy, "next": aurora, "origin": "agent"})
    );

    let again = set(&fixture, global(aurora.clone())).await;
    assert_eq!((again.previous, again.changed), (aurora, false));
    assert_eq!(events(&fixture, "wallpaper.changed").await.len(), 1);
    fixture.close().await;
}

#[tokio::test]
async fn settings_and_project_patches_emit_wallpaper_changed_from_the_user() {
    let fixture = open("user-changes").await;
    let none = json!({"kind": "none"});
    fixture
        .app
        .update_settings_owned(json!({"wallpaper": {"source": none}}))
        .await
        .unwrap();
    fixture
        .app
        .update_settings_owned(
            json!({"wallpaper": {"motion": "paused"}, "translucent_sidebar": false}),
        )
        .await
        .unwrap();
    let legacy: Value = serde_json::from_str(LEGACY_DEFAULT).unwrap();
    let expected = json!({"scope": "global", "previous": legacy, "next": none, "origin": "user"});
    let changed = events(&fixture, "wallpaper.changed").await;
    assert_eq!(changed.len(), 1, "a motion change is no wallpaper change");
    assert_eq!(Value::Object(changed[0].clone()), expected);

    let id = create_project(&fixture, "Atlas").await;
    let silk = json!({"kind": "live", "module": "butler.silk"});
    let update = |revision, wallpaper| AppProjectDashboardPreferencesUpdate {
        expected_revision: revision,
        description: Some("Maps.".into()),
        pinned_source_refs: None,
        wallpaper,
    };
    let app = &fixture.app;
    app.update_project_dashboard_preferences_owned(id.clone(), update(0, None))
        .await
        .unwrap();
    app.update_project_dashboard_preferences_owned(id.clone(), update(1, Some(silk.clone())))
        .await
        .unwrap();
    let changed = events(&fixture, "wallpaper.changed").await;
    assert_eq!(changed.len(), 2);
    assert_eq!(
        Value::Object(changed[1].clone()),
        json!({"scope": "project", "projectId": id, "previous": "inherit", "next": silk, "origin": "user"})
    );
    fixture.close().await;
}

/// Sources the agent route refuses, with the field each rejection names.
fn invalid_sources() -> Vec<(Value, &'static str)> {
    vec![
        (
            json!({"kind": "live", "module": "butler.rain"}),
            "source.module",
        ),
        (
            json!({"kind": "live", "module": "butler.grain"}),
            "source.module",
        ),
        (
            json!({"kind": "live", "module": "butler.bloom", "params": {"warmth": 1}}),
            "source.params.warmth",
        ),
        (
            json!({"kind": "live", "module": "butler.bloom", "params": {"colors": "sunset"}}),
            "source.params.colors",
        ),
        (
            json!({"kind": "live", "module": "butler.silk", "paramsDark": {"base": "black"}}),
            "source.paramsDark.base",
        ),
        (
            image(&json!({"module": "butler.grain", "params": {"amount": 2}})),
            "source.filter.params.amount",
        ),
        (
            image(&json!({"module": "butler.grain", "params": {"mono": "yes"}})),
            "source.filter.params.mono",
        ),
        (
            image(&json!({"module": "butler.bloom"})),
            "source.filter.module",
        ),
        (json!({"kind": "live"}), "source.module"),
        (
            json!({"kind": "image", "asset": "wp_abcdefgh", "fit": "fill"}),
            "source.fit",
        ),
        (json!({"kind": "video"}), "source.kind"),
        (json!("inherit"), "source.kind"),
    ]
}

fn image(filter: &Value) -> Value {
    json!({"kind": "image", "asset": "wp_abcdefgh", "fit": "cover", "dim": 0, "blur": 0, "filter": filter})
}

#[tokio::test]
async fn agent_rejections_name_the_field_and_what_is_allowed() {
    let fixture = open("agent-rejections").await;
    let cases = invalid_sources();
    for (source, field) in cases {
        let rejection = reject(&fixture, global(source.clone())).await;
        assert_eq!(
            (
                rejection.status,
                rejection.code.as_str(),
                rejection.field.as_str()
            ),
            (400, "wallpaper_invalid", field),
            "{source}: {rejection:?}"
        );
        assert!(rejection.message.starts_with(field), "{rejection:?}");
    }
    // Other modules may join the UI package; these built-ins keep their roles.
    let listed = |rejection: &AppWallpaperRejection, id: &str| {
        rejection
            .allowed
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&json!(id))
    };
    let unknown = reject(
        &fixture,
        global(json!({"kind": "live", "module": "butler.rain"})),
    )
    .await;
    assert!(
        listed(&unknown, "butler.bloom") && listed(&unknown, "butler.silk"),
        "{unknown:?}"
    );
    assert!(
        !listed(&unknown, "butler.grain") && !listed(&unknown, "butler.image"),
        "{unknown:?}"
    );
    let filter = reject(&fixture, global(image(&json!({"module": "butler.bloom"})))).await;
    assert!(
        filter.message.contains("does not take an image"),
        "{filter:?}"
    );
    assert!(
        listed(&filter, "butler.grain") && !listed(&filter, "butler.bloom"),
        "{filter:?}"
    );
    let amount = reject(
        &fixture,
        global(image(
            &json!({"module": "butler.grain", "params": {"amount": 2}}),
        )),
    )
    .await;
    assert_eq!(
        amount.allowed.as_deref(),
        Some(&json!({"min": 0.0, "max": 1.0, "step": 0.05}))
    );
    let kinds = reject(&fixture, global(json!("inherit"))).await;
    assert_eq!(
        kinds.allowed.as_deref(),
        Some(&json!(["none", "live", "image", "image_from_attachment"]))
    );
    assert!(events(&fixture, "wallpaper.changed").await.is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn agent_rejects_unknown_images_and_projects_without_writing() {
    let fixture = open("agent-target-rejections").await;
    let before = fixture.app.worker_profile_settings().await.unwrap();
    let asset = reject(
        &fixture,
        global(json!({"kind": "image", "asset": "wp_unknown0000"})),
    )
    .await;
    assert_eq!(
        (asset.code.as_str(), asset.field.as_str()),
        ("wallpaper_image_not_found", "source.asset")
    );
    assert!(asset.message.contains("list_wallpapers"), "{asset:?}");
    let missing = AppWallpaperSetRequest {
        scope: AppWallpaperScope::Project,
        project_id: None,
        source: json!({"kind": "none"}),
    };
    assert_eq!(reject(&fixture, missing).await.field, "project_id");
    let nowhere = reject(
        &fixture,
        project("project-missing", json!({"kind": "none"})),
    )
    .await;
    assert_eq!(
        (
            nowhere.status,
            nowhere.code.as_str(),
            nowhere.field.as_str()
        ),
        (404, "project_not_found", "project_id")
    );
    assert_eq!(fixture.app.worker_profile_settings().await.unwrap(), before);
    assert!(events(&fixture, "settings.updated").await.is_empty());
    assert!(events(&fixture, "wallpaper.changed").await.is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn agent_sets_a_project_wallpaper_at_whatever_revision_is_current() {
    let fixture = open("agent-project").await;
    let id = create_project(&fixture, "Atlas").await;
    let described = AppProjectDashboardPreferencesUpdate {
        expected_revision: 0,
        description: Some("Maps.".into()),
        pinned_source_refs: None,
        wallpaper: None,
    };
    fixture
        .app
        .update_project_dashboard_preferences_owned(id.clone(), described)
        .await
        .unwrap();
    let silk = json!({"kind": "live", "module": "butler.silk", "params": {"base": "#f4ecdc"}});
    let change = set(&fixture, project(&id, silk.clone())).await;
    assert_eq!(
        (
            change.previous,
            change.next.clone(),
            change.project_id.as_deref()
        ),
        (json!("inherit"), silk.clone(), Some(id.as_str()))
    );
    let dashboard = fixture
        .app
        .get_project_dashboard_owned(id.clone())
        .await
        .unwrap();
    assert_eq!(dashboard["description"], json!("Maps."));
    assert_eq!(dashboard["preferences"]["revision"], json!(2));
    assert_eq!(dashboard["preferences"]["wallpaper"], silk);
    let changed = events(&fixture, "wallpaper.changed").await;
    assert_eq!(
        Value::Object(changed.last().unwrap().clone()),
        json!({"scope": "project", "projectId": id, "previous": "inherit", "next": silk, "origin": "agent"})
    );
    assert_eq!(
        global_source(&fixture).await,
        serde_json::from_str::<Value>(LEGACY_DEFAULT).unwrap()
    );

    let inherit = set(&fixture, project(&id, json!({"kind": "inherit"}))).await;
    assert_eq!(
        (inherit.next.clone(), inherit.changed),
        (json!("inherit"), true)
    );
    let again = set(&fixture, project(&id, json!("inherit"))).await;
    assert!(!again.changed);
    let dashboard = fixture
        .app
        .get_project_dashboard_owned(id.clone())
        .await
        .unwrap();
    assert_eq!(
        dashboard["preferences"]["revision"],
        json!(3),
        "an unchanged wallpaper is not rewritten"
    );
    let extra = reject(
        &fixture,
        project(&id, json!({"kind": "inherit", "module": "x"})),
    )
    .await;
    assert_eq!(extra.field, "source.module");
    fixture.close().await;
}

#[tokio::test]
async fn concurrent_agent_project_writes_each_win_a_revision() {
    let fixture = open("agent-project-race").await;
    let id = create_project(&fixture, "Atlas").await;
    // Concurrent writers each win a revision in turn; none sees a conflict.
    let bases = ["#101010", "#202020", "#303030"];
    let writes = bases.map(|base| {
        let app = fixture.app.clone_handle();
        let request = project(
            &id,
            json!({"kind": "live", "module": "butler.silk", "params": {"base": base}}),
        );
        tokio::spawn(async move { app.set_wallpaper(request).await })
    });
    for write in writes {
        write.await.unwrap().unwrap().unwrap();
    }
    let dashboard = fixture
        .app
        .get_project_dashboard_owned(id.clone())
        .await
        .unwrap();
    assert_eq!(dashboard["preferences"]["revision"], json!(3));
    fixture.close().await;
}

mod images;
