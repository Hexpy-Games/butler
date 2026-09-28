//! The agent's module save: checks naming the field and rule, one atomic
//! write of both files, and a wait for the App's check of those files.

use std::time::Duration;

use super::*;
use crate::gateway::wallpapers::{AppWallpaperModuleSaveRequest, AppWallpaperModuleSaved};

fn manifest_value(id: &str) -> Value {
    serde_json::from_str(&manifest(id)).unwrap()
}

fn request(id: &str, manifest: Value, shader: &str) -> AppWallpaperModuleSaveRequest {
    AppWallpaperModuleSaveRequest {
        id: id.into(),
        manifest,
        shader: shader.into(),
        overlay: None,
    }
}

fn rain(shader: &str) -> AppWallpaperModuleSaveRequest {
    request("user.rain", manifest_value("user.rain"), shader)
}

async fn save_within(
    fixture: &Fixture,
    request: AppWallpaperModuleSaveRequest,
    wait: Duration,
) -> Result<AppWallpaperModuleSaved, AppWallpaperRejection> {
    fixture.app.save_module(request, wait).await.unwrap()
}

/// Every entry directly under the module root, sorted.
fn listing(fixture: &Fixture) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(root(fixture))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn a_save_names_the_field_and_rule_it_breaks_and_writes_nothing() {
    let fixture = open("modules-save-checks").await;
    let mut nameless = manifest_value("user.rain");
    nameless.as_object_mut().unwrap().remove("name");
    let mut bulky = manifest_value("user.rain");
    bulky["notes"] = json!("x".repeat(33 * 1024));
    let large_shader = format!("void main(){{}}\n{}", "//".repeat(33 * 1024));
    let cases = [
        (
            request("butler.rain", manifest_value("butler.rain"), FRAGMENT),
            "id",
            "reserved",
        ),
        (
            request("Rain", manifest_value("user.rain"), FRAGMENT),
            "id",
            "must match",
        ),
        (
            request("user.rain", json!("{}"), FRAGMENT),
            "manifest",
            "object",
        ),
        (
            request("user.rain", manifest_value("user.fern"), FRAGMENT),
            "manifest.id",
            "user.rain",
        ),
        (
            request("user.rain", nameless, FRAGMENT),
            "manifest.name",
            "needs non-empty en and ko",
        ),
        (
            request("user.rain", bulky, FRAGMENT),
            "manifest",
            "at most 32 KB",
        ),
        (rain(&large_shader), "shader", "at most 64 KB"),
    ];
    for (request, field, rule) in cases {
        let id = request.id.clone();
        let rejection = save_within(&fixture, request, Duration::ZERO)
            .await
            .unwrap_err();
        assert_eq!(
            (
                rejection.status,
                rejection.code.as_str(),
                rejection.field.as_str()
            ),
            (400, "wallpaper_module_invalid", field),
            "{id}: {}",
            rejection.message
        );
        assert!(
            rejection.message.starts_with(field) && rejection.message.contains(rule),
            "{}",
            rejection.message
        );
    }
    assert_eq!(listing(&fixture), Vec::<String>::new());
    fixture.close().await;
}

#[tokio::test]
async fn a_save_names_every_broken_rule_the_first_as_its_field() {
    let fixture = open("modules-save-rules").await;
    let mut broken = manifest_value("user.rain");
    broken["engine"] = json!(2);
    broken["motion"] = json!("fast");
    let rejection = save_within(&fixture, rain_with(broken), Duration::ZERO)
        .await
        .unwrap_err();
    assert_eq!(rejection.field, "manifest.engine");
    assert!(
        rejection.message.contains("manifest.engine must be 1")
            && rejection
                .message
                .contains("manifest.motion must be static or animated"),
        "{}",
        rejection.message
    );
    fixture.close().await;
}

fn rain_with(manifest: Value) -> AppWallpaperModuleSaveRequest {
    request("user.rain", manifest, FRAGMENT)
}

#[tokio::test]
async fn a_save_writes_both_files_at_once_and_replaces_an_older_copy() {
    let fixture = open("modules-save-write").await;
    let saved = save_within(&fixture, rain(FRAGMENT), Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(saved.id, "user.rain");
    let folder = root(&fixture).join("user.rain");
    let written: Value =
        serde_json::from_slice(&std::fs::read(folder.join("wallpaper.json")).unwrap()).unwrap();
    assert_eq!(written, manifest_value("user.rain"));
    assert_eq!(
        std::fs::read_to_string(folder.join("shader.frag")).unwrap(),
        FRAGMENT
    );
    assert_eq!(listing(&fixture), ["user.rain"]);
    let listed = status(&fixture, "user.rain").await;
    assert_eq!(listed, json!({"state": "unknown"}));

    // A refused save leaves the saved module as it was.
    let refused = save_within(
        &fixture,
        request("user.rain", manifest_value("user.fern"), "void main(){}"),
        Duration::ZERO,
    )
    .await;
    assert!(refused.is_err());
    assert_eq!(
        std::fs::read_to_string(folder.join("shader.frag")).unwrap(),
        FRAGMENT
    );

    // Saving the id again replaces the folder, leaving no staging behind.
    std::fs::write(folder.join("thumbnail.png"), b"old").unwrap();
    let next = "void main(){fragColor=vec4(1.);}";
    save_within(&fixture, rain(next), Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(folder.join("shader.frag")).unwrap(),
        next
    );
    assert!(!folder.join("thumbnail.png").exists());
    assert_eq!(listing(&fixture), ["user.rain"]);
    fixture.close().await;
}

/// Reports `state` for the files of `id` once they hold `shader`, as the App
/// does after compiling them.
async fn post_status(app: &AppApplication, id: &str, shader: &str, state: &str, log: Option<&str>) {
    let revision = loop {
        if let Ok(served) = app.wallpaper_module_shader(id.into()).await
            && served.text == shader
        {
            break served.revision;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let report = AppWallpaperModuleStatusReport {
        revision: Some(revision),
        ..super::report(state, log)
    };
    app.report_wallpaper_module_status(id.into(), report)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_save_returns_the_app_check_of_the_saved_files() {
    let fixture = open("modules-save-wait").await;
    let app = &fixture.app;
    let (saved, ()) = tokio::join!(
        app.save_wallpaper_module(rain(FRAGMENT)),
        post_status(app, "user.rain", FRAGMENT, "ok", None)
    );
    let saved = saved.unwrap().unwrap();
    assert_eq!(saved.id, "user.rain");
    assert_eq!(saved.status["state"], "ok");

    let broken = "void main(){fragColor=vec4(p_x);}";
    let log = "ERROR: 0:1: 'p_x' : undeclared identifier";
    let (saved, ()) = tokio::join!(
        app.save_wallpaper_module(rain(broken)),
        post_status(app, "user.rain", broken, "error", Some(log))
    );
    let status = saved.unwrap().unwrap().status;
    assert_eq!(
        (&status["state"], &status["message"]),
        (&json!("error"), &json!(log))
    );

    // Unchanged files keep their check, so a repeated save answers at once.
    let again = save_within(&fixture, rain(broken), Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(again.status["message"], log);

    // An earlier revision's check is not these files' check: with no App to
    // check them, the save says so once the wait runs out.
    let started = tokio::time::Instant::now();
    let unchecked = save_within(&fixture, rain(FRAGMENT), Duration::from_millis(300))
        .await
        .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(300));
    assert_eq!(unchecked.status["state"], "unknown");
    let message = unchecked.status["message"].as_str().unwrap();
    assert!(
        message.contains("App") && message.contains("set_wallpaper"),
        "{message}"
    );
    fixture.close().await;
}

#[tokio::test]
async fn a_save_writes_the_overlay_and_keeps_the_image_of_the_module_it_replaces() {
    let fixture = open("modules-save-extras").await;
    let mut scene = manifest_value("user.rain");
    scene["image"] = json!("optional");
    scene["overlay"] = json!(true);
    let mut save = rain_with(scene.clone());
    let rejection = save_within(&fixture, save.clone(), Duration::ZERO)
        .await
        .unwrap_err();
    assert_eq!(rejection.field, "overlay", "{}", rejection.message);
    save.overlay = Some(FRAGMENT.into());
    save_within(&fixture, save.clone(), Duration::ZERO)
        .await
        .unwrap();
    let folder = root(&fixture).join("user.rain");
    assert_eq!(
        std::fs::read_to_string(folder.join("overlay.frag")).unwrap(),
        FRAGMENT
    );

    scene["defaultImage"] = json!("photo.jpg");
    save.manifest = scene;
    let rejection = save_within(&fixture, save.clone(), Duration::ZERO)
        .await
        .unwrap_err();
    assert_eq!(rejection.field, "manifest.defaultImage");
    assert!(
        rejection.message.contains("cannot add one"),
        "{}",
        rejection.message
    );
    let jpeg = b"\xff\xd8\xff\xe0 jpeg";
    std::fs::write(folder.join("photo.jpg"), jpeg).unwrap();
    save_within(&fixture, save, Duration::ZERO).await.unwrap();
    assert_eq!(std::fs::read(folder.join("photo.jpg")).unwrap(), jpeg);
    let image = fixture
        .app
        .wallpaper_module_image("user.rain".into())
        .await
        .unwrap();
    assert_eq!(image.mime_type, "image/jpeg");
    fixture.close().await;
}
