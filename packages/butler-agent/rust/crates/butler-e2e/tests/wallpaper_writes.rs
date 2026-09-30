//! WALL (writes). Every change of an effective wallpaper is announced once,
//! with who made it (WALL-05), and an installed user module is never
//! replaced silently: the agent's save needs the module's current revision
//! (WALL-06) and an archive import needs an explicit replace (WALL-07); a
//! replacement keeps the previous files recoverable.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::io::{Cursor, Write};
use std::path::Path;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::{Gateway, Reply};
use butler_e2e::e2e::media;
use butler_e2e::e2e::scenario::Setup;
use serde_json::{Value, json};
use zip::{ZipWriter, write::SimpleFileOptions};

const FRAGMENT: &str = "void main(){fragColor=vec4(vec3(p_speed),1.);}";
const IMPORT: &str = "/wallpaper-modules/import";
const SAVE: &str = "/internal/wallpaper-modules";

fn manifest(id: &str) -> String {
    json!({
        "id": id, "name": {"en": "Rain", "ko": "비"}, "version": "1.0.0", "engine": 1,
        "motion": "animated", "image": "none",
        "params": [{"key": "speed", "label": {"en": "Speed", "ko": "속도"}, "type": "number",
                    "min": 0, "max": 1, "step": 0.1, "default": 0.5}]
    })
    .to_string()
}

/// A module archive of `(name, bytes)` files.
fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn failure(reply: &Reply) -> (u16, &str) {
    (reply.status, reply.error_code().unwrap_or_default())
}

fn message(reply: &Reply) -> &str {
    reply.body["error"]["message"].as_str().unwrap_or_default()
}

/// The listing entry of user module `id`.
async fn module(gw: &Gateway, id: &str) -> Result<Value, HarnessError> {
    let reply = gw.get("/wallpaper-modules").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|module| module["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("{id} not listed: {}", reply.text)))
}

/// Plays the App for one save: waits until module `id` has files other than
/// revision `before`, marks them `checking` (the save keeps waiting), then
/// reports them `ok`.
async fn app_checks(gw: &Gateway, id: &str, before: &str) -> Result<(), HarnessError> {
    let path = format!("/wallpaper-modules/{id}/status");
    for _ in 0..100 {
        let revision = module(gw, id).await?["revision"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if revision != before {
            let checking = gw
                .post(&path, json!({"state": "checking", "revision": revision}))
                .await?;
            assert_eq!(checking.status, 200, "{}", checking.text);
            assert_eq!(module(gw, id).await?["status"]["state"], "checking");
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let ok = gw
                .post(&path, json!({"state": "ok", "revision": revision}))
                .await?;
            assert_eq!(ok.status, 200, "{}", ok.text);
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("{id} was never written");
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// A concurrent listing must see the old or new module throughout a save,
/// including the interval between moving the old folder aside and publishing
/// its replacement. The save still waits for the App's normal status check.
async fn save_while_listed(gw: &Gateway, request: Value) -> Result<Reply, HarnessError> {
    let saving = gw.post(SAVE, request);
    tokio::pin!(saving);
    loop {
        tokio::select! {
            reply = &mut saving => return reply,
            listed = module(gw, "user.rain") => { listed?; }
        }
    }
}

/// WALL-05 — `wallpaper.changed` announces each change of an effective
/// wallpaper once, with its scope and who made it: the settings screen
/// (`user`) or the agent route (`agent`), globally and for one project.
/// Writing the wallpaper it already shows announces nothing.
#[tokio::test]
async fn wall_05_wallpaper_changes_are_announced_once_with_their_origin() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = Setup::new("WALL-05")?.start().await?;
    let created =
        s.gw.post(
            "/projects",
            json!({"source": "scratch", "display_name": "Walls"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let cursor =
        s.gw.events_since(0)
            .await?
            .last()
            .and_then(|event| event["id"].as_u64())
            .unwrap_or(0);

    let silk = json!({"kind": "live", "module": "butler.silk"});
    let none = json!({"kind": "none"});
    let user =
        s.gw.patch("/settings", json!({"wallpaper": {"source": silk}}))
            .await?;
    assert_eq!(user.status, 200, "{}", user.text);
    let same =
        s.gw.patch("/settings", json!({"wallpaper": {"source": silk}}))
            .await?;
    assert_eq!(same.status, 200, "{}", same.text);
    let agent =
        s.gw.post(
            "/internal/wallpaper",
            json!({"scope": "global", "source": none}),
        )
        .await?;
    assert_eq!(agent.status, 200, "{}", agent.text);
    assert_eq!(agent.data()["changed"], true, "{}", agent.text);
    let to_project = json!({"scope": "project", "project_id": project, "source": silk});
    let scoped = s.gw.post("/internal/wallpaper", to_project.clone()).await?;
    assert_eq!(scoped.status, 200, "{}", scoped.text);
    let unchanged = s.gw.post("/internal/wallpaper", to_project).await?;
    assert_eq!(unchanged.data()["changed"], false, "{}", unchanged.text);

    let changes: Vec<Value> =
        s.gw.events_since(cursor)
            .await?
            .into_iter()
            .filter(|event| event["type"] == "wallpaper.changed")
            .map(|event| event["payload"].clone())
            .collect();
    assert_eq!(changes.len(), 3, "{changes:?}");
    assert_eq!(
        (
            &changes[0]["scope"],
            &changes[0]["origin"],
            &changes[0]["next"]
        ),
        (&json!("global"), &json!("user"), &silk),
        "{changes:?}"
    );
    assert_eq!(
        (
            &changes[1]["scope"],
            &changes[1]["origin"],
            &changes[1]["previous"],
            &changes[1]["next"]
        ),
        (&json!("global"), &json!("agent"), &silk, &none),
        "{changes:?}"
    );
    assert_eq!(
        (
            &changes[2]["scope"],
            &changes[2]["projectId"],
            &changes[2]["origin"]
        ),
        (&json!("project"), &json!(project), &json!("agent")),
        "{changes:?}"
    );
    assert_eq!(changes[2]["previous"], "inherit", "{changes:?}");
    assert_eq!(changes[2]["next"], silk, "{changes:?}");
    s.finish().await
}

/// WALL-06 — The agent's save never silently replaces an installed module:
/// without its current revision the save is refused (409, naming
/// `replace_revision`) and nothing changes. With it, the module is replaced,
/// its thumbnail stays and the replaced files are kept recoverable; the
/// save waits past the App's `checking` mark for its verdict. Saving the
/// current files again is a no-op. A default image whose header claims too
/// many pixels makes its module an error before anything draws it.
#[tokio::test]
async fn wall_06_module_saves_never_silently_replace_a_module() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WALL-06")?.start().await?;
    let root = s.sandbox.data.join("wallpapers");
    let folder = root.join("user.rain");
    std::fs::create_dir_all(&folder)?;
    std::fs::write(folder.join("wallpaper.json"), manifest("user.rain"))?;
    std::fs::write(folder.join("shader.frag"), FRAGMENT)?;
    let thumbnail = media::digits_png("7", 2);
    std::fs::write(folder.join("thumbnail.png"), &thumbnail)?;
    let before = module(&s.gw, "user.rain").await?["revision"]
        .as_str()
        .unwrap()
        .to_owned();

    let edited = "void main(){fragColor=vec4(vec3(p_speed*.5),1.);}";
    let save = |revision: Option<&str>| {
        let mut request = json!({"id": "user.rain",
            "manifest": serde_json::from_str::<Value>(&manifest("user.rain")).unwrap(),
            "shader": edited});
        if let Some(revision) = revision {
            request["replace_revision"] = json!(revision);
        }
        request
    };
    for revision in [None, Some("0123456789abcdef0123456789abcdef")] {
        let refused = s.gw.post(SAVE, save(revision)).await?;
        assert_eq!(
            (
                refused.status,
                refused.error_code(),
                refused.body["error"]["field"].as_str()
            ),
            (
                409,
                Some("wallpaper_module_exists"),
                Some("replace_revision")
            ),
            "{}",
            refused.text
        );
        assert!(
            message(&refused).contains("list_wallpapers"),
            "{}",
            refused.text
        );
    }
    assert_eq!(read(&folder.join("shader.frag")), FRAGMENT);

    let (saved, checked) = tokio::join!(
        save_while_listed(&s.gw, save(Some(&before))),
        app_checks(&s.gw, "user.rain", &before)
    );
    let saved = saved?;
    checked?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    assert_eq!(saved.data()["status"]["state"], "ok", "{}", saved.text);
    assert_eq!(read(&folder.join("shader.frag")), edited);
    assert_eq!(std::fs::read(folder.join("thumbnail.png"))?, thumbnail);
    assert_eq!(
        read(&root.join(".previous/user.rain/shader.frag")),
        FRAGMENT
    );

    let repeated = s.gw.post(SAVE, save(None)).await?;
    assert_eq!(repeated.status, 200, "{}", repeated.text);
    assert_eq!(
        repeated.data()["status"]["state"],
        "ok",
        "{}",
        repeated.text
    );

    let bomb = root.join("user.bomb");
    std::fs::create_dir_all(&bomb)?;
    let mut photo: Value = serde_json::from_str(&manifest("user.bomb")).unwrap();
    photo["image"] = json!("optional");
    photo["defaultImage"] = json!("photo.png");
    std::fs::write(bomb.join("wallpaper.json"), photo.to_string())?;
    std::fs::write(bomb.join("shader.frag"), FRAGMENT)?;
    std::fs::write(bomb.join("photo.png"), media::png_claiming(20_000, 20_000))?;
    let listed = module(&s.gw, "user.bomb").await?;
    assert_eq!(listed["status"]["state"], "error", "{listed}");
    assert!(
        listed["status"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("20000x20000"),
        "{listed}"
    );
    let image = s.gw.get("/wallpaper-modules/user.bomb/image").await?;
    assert_ne!(image.status, 200, "{}", image.text);
    s.finish().await
}

/// WALL-07 — Importing an archive over an installed module is refused
/// (409 `wallpaper_module_exists`) and changes nothing; asked to replace,
/// the import installs and the replaced copy is kept under `.previous`.
#[tokio::test]
async fn wall_07_module_imports_replace_only_when_asked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WALL-07")?.start().await?;
    let root = s.sandbox.data.join("wallpapers");
    let body = manifest("user.rain");
    let first = archive(&[
        ("wallpaper.json", body.as_bytes()),
        ("shader.frag", FRAGMENT.as_bytes()),
    ]);
    let imported =
        s.gw.upload_file(IMPORT, "rain.zip", "application/zip", &first)
            .await?;
    assert_eq!(imported.status, 201, "{}", imported.text);

    let edited = "void main(){fragColor=vec4(0.);}";
    let update = archive(&[
        ("wallpaper.json", body.as_bytes()),
        ("shader.frag", edited.as_bytes()),
    ]);
    let again =
        s.gw.upload_file(IMPORT, "rain.zip", "application/zip", &update)
            .await?;
    assert_eq!(
        failure(&again),
        (409, "wallpaper_module_exists"),
        "{}",
        again.text
    );
    assert_eq!(read(&root.join("user.rain/shader.frag")), FRAGMENT);
    let replaced =
        s.gw.upload_file(
            &format!("{IMPORT}?replace=1"),
            "rain.zip",
            "application/zip",
            &update,
        )
        .await?;
    assert_eq!(replaced.status, 201, "{}", replaced.text);
    assert_eq!(read(&root.join("user.rain/shader.frag")), edited);
    assert_eq!(
        read(&root.join(".previous/user.rain/shader.frag")),
        FRAGMENT
    );
    s.finish().await
}
