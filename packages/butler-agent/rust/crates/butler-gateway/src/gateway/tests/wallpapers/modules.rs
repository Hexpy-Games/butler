//! User wallpaper modules over HTTP: shader, status, import and delete.

use super::*;
use crate::gateway::wallpaper_modules::{
    import::tests::{Entry, archive, module_archive},
    user::tests::{FRAGMENT, manifest, write},
};

#[tokio::test]
async fn module_routes_serve_the_shader_and_take_status_reports() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let root = harness.data.join("wallpapers");
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    let anonymous = call(address, "GET /wallpaper-modules/user.rain/shader", &[], &[]).await;
    assert_eq!(anonymous.status, 401);
    let shader = authorized(address, "GET /wallpaper-modules/user.rain/shader", &[]).await;
    assert_eq!(shader.status, 200);
    assert_eq!(
        shader.header("content-type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(shader.header("cache-control"), Some("no-store"));
    assert_eq!(shader.body, FRAGMENT.as_bytes());
    let etag = shader.header("etag").unwrap().to_owned();
    let revision = etag.trim_matches('"').to_owned();
    assert_eq!(revision.len(), 32);
    let builtin = authorized(address, "GET /wallpaper-modules/butler.bloom/shader", &[]).await;
    assert_eq!(
        failure(&builtin),
        (404, "wallpaper_module_not_found".into())
    );

    let body = json!({"state": "error", "message": "0:1: syntax error", "revision": revision});
    let path = "POST /wallpaper-modules/user.rain/status";
    let reported = authorized(address, path, body.to_string().as_bytes()).await;
    assert_eq!(
        reported.status,
        200,
        "{}",
        String::from_utf8_lossy(&reported.body)
    );
    assert_eq!(reported.json()["data"]["status"]["state"], "error");
    let listed = authorized(address, "GET /wallpaper-modules", &[]).await;
    let modules = listed.json()["data"]["modules"].clone();
    let rain = modules
        .as_array()
        .unwrap()
        .iter()
        .find(|module| module["id"] == "user.rain")
        .unwrap()
        .clone();
    assert_eq!(rain["source"], "user");
    assert_eq!(rain["status"]["message"], "0:1: syntax error");
    let malformed = authorized(address, path, b"{\"state\": 1}").await;
    assert_eq!(
        failure(&malformed),
        (400, "wallpaper_module_status_invalid".into())
    );
    harness.close().await;
}

async fn import(address: SocketAddr, bytes: &[u8]) -> Reply {
    upload(
        address,
        "/wallpaper-modules/import",
        "rain.zip",
        "application/zip",
        bytes,
    )
    .await
}

#[tokio::test]
async fn module_archives_are_imported_and_unused_modules_deleted() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let imported = import(address, &module_archive("user.rain", "")).await;
    assert_eq!(
        imported.status,
        201,
        "{}",
        String::from_utf8_lossy(&imported.body)
    );
    assert_eq!(imported.json()["data"]["id"], "user.rain");
    assert!(
        harness
            .data
            .join("wallpapers/user.rain/shader.frag")
            .is_file()
    );
    let manifest = manifest("user.fern");
    let escaping = archive(&[
        Entry::File("wallpaper.json", manifest.as_bytes(), 0o644),
        Entry::File("../../shader.frag", FRAGMENT.as_bytes(), 0o644),
    ]);
    let refused = import(address, &escaping).await;
    assert_eq!(
        failure(&refused),
        (400, "wallpaper_module_archive_invalid".into())
    );
    assert!(!harness.data.join("shader.frag").exists());
    let mut large = module_archive("user.fern", "");
    large.resize(3 * 1024 * 1024, 0);
    let refused = import(address, &large).await;
    assert_eq!(
        failure(&refused),
        (413, "wallpaper_module_archive_too_large".into())
    );

    let source = json!({"wallpaper": {"source": {"kind": "live", "module": "user.rain"}}});
    let patched = authorized(address, "PATCH /settings", source.to_string().as_bytes()).await;
    assert_eq!(
        patched.status,
        200,
        "{}",
        String::from_utf8_lossy(&patched.body)
    );
    let in_use = authorized(address, "DELETE /wallpaper-modules/user.rain", &[]).await;
    assert_eq!(failure(&in_use), (409, "wallpaper_module_in_use".into()));
    let none = json!({"wallpaper": {"source": {"kind": "none"}}});
    authorized(address, "PATCH /settings", none.to_string().as_bytes()).await;
    let deleted = authorized(address, "DELETE /wallpaper-modules/user.rain", &[]).await;
    assert_eq!(
        deleted.json()["data"],
        json!({"id": "user.rain", "deleted": true})
    );
    let builtin = authorized(address, "DELETE /wallpaper-modules/butler.bloom", &[]).await;
    assert_eq!(failure(&builtin), (400, "wallpaper_module_builtin".into()));
    harness.close().await;
}

/// Reports `ok` for `user.rain` over HTTP once its files hold `shader`.
async fn check_over_http(address: SocketAddr, shader: &str) {
    let revision = loop {
        let served = authorized(address, "GET /wallpaper-modules/user.rain/shader", &[]).await;
        if served.status == 200 && served.body == shader.as_bytes() {
            break served.header("etag").unwrap().trim_matches('"').to_owned();
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    let body = json!({"state": "ok", "revision": revision});
    let path = "POST /wallpaper-modules/user.rain/status";
    let reported = authorized(address, path, body.to_string().as_bytes()).await;
    assert_eq!(reported.status, 200);
}

#[tokio::test]
async fn the_agent_saves_a_module_and_gets_the_app_check() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let path = "POST /internal/wallpaper-modules";
    let manifest: Value = serde_json::from_str(&manifest("user.rain")).unwrap();
    let anonymous = call(address, path, &[], b"{}").await;
    assert_eq!(anonymous.status, 401);

    let reserved = json!({"id": "butler.rain", "manifest": manifest, "shader": FRAGMENT});
    let refused = authorized(address, path, reserved.to_string().as_bytes()).await;
    assert_eq!(failure(&refused), (400, "wallpaper_module_invalid".into()));
    assert_eq!(refused.json()["error"]["field"], "id");
    let malformed = authorized(address, path, b"{\"id\": \"user.rain\"}").await;
    assert_eq!(
        failure(&malformed),
        (400, "wallpaper_module_request_invalid".into())
    );

    let body = json!({"id": "user.rain", "manifest": manifest, "shader": FRAGMENT}).to_string();
    let (saved, ()) = tokio::join!(
        authorized(address, path, body.as_bytes()),
        check_over_http(address, FRAGMENT)
    );
    assert_eq!(
        saved.status,
        200,
        "{}",
        String::from_utf8_lossy(&saved.body)
    );
    let data = saved.json()["data"].clone();
    assert_eq!(data["id"], "user.rain");
    assert_eq!(data["status"]["state"], "ok");
    assert!(
        harness
            .data
            .join("wallpapers/user.rain/wallpaper.json")
            .is_file()
    );
    harness.close().await;
}
