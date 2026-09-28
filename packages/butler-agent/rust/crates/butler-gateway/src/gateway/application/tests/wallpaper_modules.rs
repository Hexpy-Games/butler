//! User-authored wallpaper modules: listing with status, status reports,
//! import, deletion while in use, the agent's choices and change events.

mod save;

use std::path::PathBuf;

use super::project_wallpaper::create_project;
use super::wallpapers::{Fixture, open, public_code};
use super::*;
use crate::gateway::{
    AppWallpaperModuleStatusReport, AppWallpaperRejection, AppWallpaperScope,
    AppWallpaperSetRequest, GatewayWallpapers,
    wallpaper_modules::{
        import::tests::module_archive,
        user::tests::{FRAGMENT, manifest, write},
    },
};

fn root(fixture: &Fixture) -> PathBuf {
    fixture.data.join("wallpapers")
}

fn entry<'a>(modules: &'a [Value], id: &str) -> &'a Value {
    modules
        .iter()
        .find(|module| module["id"] == id)
        .unwrap_or_else(|| panic!("{id} is not listed"))
}

fn report(state: &str, message: Option<&str>) -> AppWallpaperModuleStatusReport {
    AppWallpaperModuleStatusReport {
        state: state.into(),
        message: message.map(str::to_owned),
        revision: None,
    }
}

async fn status(fixture: &Fixture, id: &str) -> Value {
    let modules = fixture.app.wallpaper_modules().await.unwrap();
    entry(&modules, id)["status"].clone()
}

fn live(module: &str, params: Value) -> Value {
    let mut source = json!({"kind": "live", "module": module});
    source["params"] = params;
    source
}

async fn set(
    fixture: &Fixture,
    project_id: Option<&str>,
    source: Value,
) -> Result<(), AppWallpaperRejection> {
    let request = AppWallpaperSetRequest {
        scope: if project_id.is_some() {
            AppWallpaperScope::Project
        } else {
            AppWallpaperScope::Global
        },
        project_id: project_id.map(str::to_owned),
        source,
    };
    fixture
        .app
        .set_wallpaper(request)
        .await
        .unwrap()
        .map(|_| ())
}

#[tokio::test]
async fn user_modules_follow_the_builtins_with_source_and_status() {
    let fixture = open("modules-list").await;
    write(
        &root(&fixture),
        "user.rain",
        &manifest("user.rain"),
        Some(FRAGMENT),
    );
    write(
        &root(&fixture),
        "user.moss",
        &manifest("user.fern"),
        Some(FRAGMENT),
    );
    let modules = fixture.app.wallpaper_modules().await.unwrap();
    let sources: Vec<_> = modules
        .iter()
        .map(|module| {
            (
                module["id"].as_str().unwrap(),
                module["source"].as_str().unwrap(),
            )
        })
        .collect();
    let users = sources
        .iter()
        .position(|(_, source)| *source == "user")
        .unwrap();
    assert!(
        sources[..users]
            .iter()
            .all(|(_, source)| *source == "builtin")
    );
    assert_eq!(
        &sources[users..],
        [("user.moss", "user"), ("user.rain", "user")]
    );
    assert_eq!(
        entry(&modules, "butler.bloom")["status"],
        json!({"state": "ok"})
    );
    let rain = entry(&modules, "user.rain");
    assert_eq!(rain["status"], json!({"state": "unknown"}));
    assert_eq!(rain["params"][0]["key"], "speed");
    let moss = entry(&modules, "user.moss");
    assert_eq!(moss["status"]["state"], "error");
    let message = moss["status"]["message"].as_str().unwrap();
    assert!(
        message.contains("id: must name its folder user.moss"),
        "{message}"
    );
    fixture.close().await;
}

#[tokio::test]
async fn a_reported_status_holds_until_the_module_files_change() {
    let fixture = open("modules-status").await;
    let root = root(&fixture);
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    let app = &fixture.app;
    let stored = app
        .report_wallpaper_module_status("user.rain".into(), report("ok", None))
        .await
        .unwrap();
    assert_eq!(
        stored,
        json!({"state": "ok", "checkedAt": "2026-09-14T00:00:00.000Z"})
    );
    assert_eq!(status(&fixture, "user.rain").await, stored);
    let long = "e".repeat(5000);
    let failed = app
        .report_wallpaper_module_status("user.rain".into(), report("error", Some(&long)))
        .await
        .unwrap();
    let message = failed["message"].as_str().unwrap();
    assert!(
        message.chars().count() <= 2000 && message.starts_with("eee"),
        "{message}"
    );
    assert_eq!(status(&fixture, "user.rain").await, failed);

    let shader = app
        .wallpaper_module_shader("user.rain".into())
        .await
        .unwrap();
    assert_eq!(shader.text, FRAGMENT);
    std::fs::write(root.join("user.rain/shader.frag"), "void main(){}").unwrap();
    assert_eq!(
        status(&fixture, "user.rain").await,
        json!({"state": "unknown"})
    );
    let stale = AppWallpaperModuleStatusReport {
        revision: Some(shader.revision),
        ..report("ok", None)
    };
    let refused = app
        .report_wallpaper_module_status("user.rain".into(), stale)
        .await;
    assert_eq!(
        public_code(refused.unwrap_err()).1,
        "wallpaper_module_changed"
    );
    assert_eq!(
        status(&fixture, "user.rain").await,
        json!({"state": "unknown"})
    );

    for (id, state, code) in [
        ("butler.bloom", "ok", "wallpaper_module_builtin"),
        ("user.none", "ok", "wallpaper_module_not_found"),
        ("user.rain", "maybe", "wallpaper_module_status_invalid"),
    ] {
        let error = app
            .report_wallpaper_module_status(id.into(), report(state, None))
            .await
            .unwrap_err();
        assert_eq!(public_code(error).1, code, "{id} {state}");
    }
    let builtin = app.wallpaper_module_shader("butler.bloom".into()).await;
    assert_eq!(
        public_code(builtin.unwrap_err()).1,
        "wallpaper_module_not_found"
    );
    fixture.close().await;
}

#[tokio::test]
async fn the_agent_may_choose_a_user_module_unless_it_fails() {
    let fixture = open("modules-agent").await;
    let root = root(&fixture);
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    write(&root, "user.moss", &manifest("user.fern"), Some(FRAGMENT));
    set(&fixture, None, live("user.rain", json!({"speed": 0.3})))
        .await
        .unwrap();
    let wrong = set(&fixture, None, live("user.rain", json!({"speed": 3}))).await;
    assert_eq!(wrong.unwrap_err().field, "source.params.speed");

    let overview = fixture.app.wallpaper_overview(None).await.unwrap();
    let modules = overview["modules"].as_array().unwrap();
    assert_eq!(entry(modules, "user.rain")["source"], "user");
    assert_eq!(
        entry(modules, "user.rain")["status"],
        json!({"state": "unknown"})
    );
    assert_eq!(entry(modules, "butler.bloom")["source"], "builtin");
    assert_eq!(
        overview["userModuleDirectory"],
        json!(root.to_string_lossy())
    );

    let log = "ERROR: 0:1: 'x' : undeclared identifier";
    fixture
        .app
        .report_wallpaper_module_status("user.rain".into(), report("error", Some(log)))
        .await
        .unwrap();
    for (id, expected) in [
        ("user.rain", log),
        ("user.moss", "id: must name its folder"),
    ] {
        let rejection = set(&fixture, None, live(id, json!({}))).await.unwrap_err();
        assert_eq!(
            (
                rejection.status,
                rejection.code.as_str(),
                rejection.field.as_str()
            ),
            (400, "wallpaper_module_error", "source.module")
        );
        assert!(
            rejection.message.contains(expected),
            "{}",
            rejection.message
        );
        let allowed = rejection.allowed.map(|allowed| *allowed).unwrap();
        assert!(allowed.as_array().unwrap().contains(&json!("butler.bloom")));
        assert!(
            !allowed.as_array().unwrap().contains(&json!(id)),
            "{allowed}"
        );
    }
    fixture.close().await;
}

#[tokio::test]
async fn a_user_module_in_use_is_not_deleted() {
    let fixture = open("modules-delete").await;
    let root = root(&fixture);
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    let app = &fixture.app;
    app.report_wallpaper_module_status("user.rain".into(), report("ok", None))
        .await
        .unwrap();
    set(&fixture, None, live("user.rain", json!({})))
        .await
        .unwrap();
    let project = create_project(&fixture, "Atlas").await;
    set(&fixture, Some(&project), live("user.rain", json!({})))
        .await
        .unwrap();
    let (http, code, message) = public_code(
        app.delete_wallpaper_module("user.rain".into())
            .await
            .unwrap_err(),
    );
    assert_eq!((http, code.as_str()), (409, "wallpaper_module_in_use"));
    assert!(message.contains("settings.wallpaper"), "{message}");
    assert!(
        message.contains(&format!("projects.{project}.wallpaper")),
        "{message}"
    );

    set(&fixture, None, json!({"kind": "none"})).await.unwrap();
    set(&fixture, Some(&project), json!("inherit"))
        .await
        .unwrap();
    app.delete_wallpaper_module("user.rain".into())
        .await
        .unwrap();
    assert!(!root.join("user.rain").exists());
    let modules = app.wallpaper_modules().await.unwrap();
    assert!(modules.iter().all(|module| module["id"] != "user.rain"));
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    assert_eq!(
        status(&fixture, "user.rain").await,
        json!({"state": "unknown"})
    );

    for (id, code) in [
        ("user.none", "wallpaper_module_not_found"),
        ("butler.bloom", "wallpaper_module_builtin"),
    ] {
        let error = app.delete_wallpaper_module(id.into()).await.unwrap_err();
        assert_eq!(public_code(error).1, code, "{id}");
    }
    fixture.close().await;
}

#[tokio::test]
async fn an_imported_module_is_installed_and_listed() {
    let fixture = open("modules-import").await;
    let entry = fixture
        .app
        .import_wallpaper_module(module_archive("user.rain", "rain/").into())
        .await
        .unwrap();
    assert_eq!(
        (&entry["id"], &entry["source"], &entry["status"]),
        (
            &json!("user.rain"),
            &json!("user"),
            &json!({"state": "unknown"})
        )
    );
    assert!(root(&fixture).join("user.rain/shader.frag").is_file());
    let refused = fixture
        .app
        .import_wallpaper_module(module_archive("butler.rain", "").into())
        .await
        .unwrap_err();
    assert_eq!(public_code(refused).1, "wallpaper_module_invalid");
    fixture.close().await;
}

#[tokio::test]
async fn module_file_changes_emit_an_update_naming_the_modules() {
    let fixture = open("modules-watch").await;
    fixture.app.watch_wallpaper_modules();
    write(
        &root(&fixture),
        "user.rain",
        &manifest("user.rain"),
        Some(FRAGMENT),
    );
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let payload = loop {
        let events = fixture.app.replay_events(0.0, 500).await.unwrap();
        if let Some(event) = events
            .into_iter()
            .find(|event| event.event_type == "wallpaper.modules.updated")
        {
            break event.payload;
        }
        assert!(tokio::time::Instant::now() < deadline, "no update event");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert_eq!(Value::Object(payload), json!({"ids": ["user.rain"]}));
    fixture.close().await;
}
