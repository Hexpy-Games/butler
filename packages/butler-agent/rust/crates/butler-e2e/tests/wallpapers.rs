//! WALL. Wallpaper security boundaries: uploaded images are checked from
//! their content and header before decoding, module archives and saves
//! never write outside their module folder, a user module's linked file is
//! never served, and Settings accept only wallpapers inside the contract
//! (a legacy theme patch re-derives the wallpaper only until one is chosen).
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
use butler_platform::secure_fs::{self, FileMode};
use serde_json::{Value, json};
use zip::{ZipWriter, write::SimpleFileOptions};

const FRAGMENT: &str = "void main(){fragColor=vec4(vec3(p_speed),1.);}";
const IMPORT: &str = "/wallpaper-modules/import";

fn manifest(id: &str) -> String {
    json!({
        "id": id, "name": {"en": "Rain", "ko": "비"}, "version": "1.0.0", "engine": 1,
        "motion": "animated", "image": "none",
        "params": [{"key": "speed", "label": {"en": "Speed", "ko": "속도"}, "type": "number",
                    "min": 0, "max": 1, "step": 0.1, "default": 0.5}]
    })
    .to_string()
}

/// One archive entry: a file with its mode, or a symbolic link.
enum Entry<'a> {
    File(&'a str, &'a [u8], FileMode),
    Link(&'a str, &'a str),
}

fn archive(entries: &[Entry<'_>]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for entry in entries {
        match entry {
            Entry::File(name, bytes, mode) => {
                let options = SimpleFileOptions::default().unix_permissions(mode.bits());
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            Entry::Link(name, target) => writer
                .add_symlink(*name, *target, SimpleFileOptions::default())
                .unwrap(),
        }
    }
    writer.finish().unwrap().into_inner()
}

fn failure(reply: &Reply) -> (u16, &str) {
    (reply.status, reply.error_code().unwrap_or_default())
}

fn message(reply: &Reply) -> &str {
    reply.body["error"]["message"].as_str().unwrap_or_default()
}

async fn module_ids(gw: &Gateway) -> Result<Vec<String>, HarnessError> {
    let reply = gw.get("/wallpaper-modules").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["modules"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|module| module["source"] == "user")
        .map(|module| module["id"].as_str().unwrap_or_default().to_owned())
        .collect())
}

/// Every file under `root`, relative to it.
fn files(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push(path.strip_prefix(root).unwrap().display().to_string());
            }
        }
    }
    found.sort();
    found
}

/// WALL-01 — Wallpaper uploads need the token, are typed by content (a
/// declared type is ignored), refused over 25 MiB and refused from the
/// header when their dimensions are absurd; a refused upload stores
/// nothing. An accepted image is served `nosniff`, and an asset the
/// setting draws with cannot be deleted.
#[tokio::test]
async fn wall_01_image_uploads_are_checked_before_decoding() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WALL-01")?.start().await?;
    let anonymous =
        s.gw.send_with(reqwest::Method::GET, "/wallpapers", None, None, &[])
            .await?;
    assert_eq!(anonymous.status, 401, "{}", anonymous.text);

    let html = b"<html>not a png</html>";
    let spoofed =
        s.gw.upload_file("/wallpapers", "photo.png", "image/png", html)
            .await?;
    assert_eq!(failure(&spoofed), (415, "wallpaper_unsupported_type"));
    let mut oversized = b"\xFF\xD8\xFF".to_vec();
    oversized.resize(25 * 1024 * 1024 + 1, 0);
    let oversized =
        s.gw.upload_file("/wallpapers", "big.jpg", "image/jpeg", &oversized)
            .await?;
    assert_eq!(failure(&oversized), (413, "wallpaper_too_large"));
    // 100 megapixels within the side limit, then one side over it.
    for (width, height) in [(10_000, 10_000), (16_385, 1)] {
        let bomb = media::png_claiming(width, height);
        let refused =
            s.gw.upload_file("/wallpapers", "bomb.png", "image/png", &bomb)
                .await?;
        assert_eq!(
            failure(&refused),
            (400, "wallpaper_dimensions_unsupported"),
            "{width}x{height}: {}",
            refused.text
        );
    }
    let listed = s.gw.get("/wallpapers").await?;
    assert_eq!(listed.data()["wallpapers"], json!([]), "{}", listed.text);

    let png = media::digits_png("42", 8);
    let created =
        s.gw.upload_file("/wallpapers", "photo.jpg", "image/jpeg", &png)
            .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["id"].as_str().unwrap().to_owned();
    let served =
        s.gw.raw(reqwest::Method::GET, &format!("/wallpapers/{id}"), &[])
            .await?;
    assert_eq!(served.status(), 200);
    assert_eq!(served.headers()["x-content-type-options"], "nosniff");
    let unknown = s.gw.get("/wallpapers/wp_0123456789.png").await?;
    assert_eq!(unknown.status, 404, "{}", unknown.text);

    let image = json!({"wallpaper": {"source": {"kind": "image", "asset": id, "fit": "cover", "dim": 0.25, "blur": 0}}});
    let patched = s.gw.patch("/settings", image).await?;
    assert_eq!(patched.status, 200, "{}", patched.text);
    let in_use = s.gw.delete(&format!("/wallpapers/{id}")).await?;
    assert_eq!(in_use.status, 409, "{}", in_use.text);
    s.finish().await
}

/// WALL-02 — A module archive is unpacked only when every entry is one of
/// the module's files in one folder: traversal, absolute paths, links,
/// executables, stray files, reserved ids and oversize archives or files
/// are refused by name and write nothing. A valid archive installs.
#[tokio::test]
async fn wall_02_module_archives_never_write_outside_their_folder() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WALL-02")?.start().await?;
    let ordinary = FileMode::ORDINARY;
    let body = manifest("user.rain");
    let body = body.as_bytes();
    let shader = FRAGMENT.as_bytes();
    let long = " ".repeat(64 * 1024 + 1);
    let invalid = "wallpaper_module_archive_invalid";
    let cases: Vec<(Vec<u8>, (u16, &str), &str)> = vec![
        (
            archive(&[
                Entry::File("wallpaper.json", body, ordinary),
                Entry::File("../../shader.frag", shader, ordinary),
            ]),
            (400, invalid),
            "../../shader.frag",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, ordinary),
                Entry::File("/tmp/shader.frag", shader, ordinary),
            ]),
            (400, invalid),
            "/tmp/shader.frag",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, ordinary),
                Entry::Link("shader.frag", "/etc/passwd"),
            ]),
            (400, invalid),
            "symbolic link",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, ordinary),
                Entry::File("shader.frag", shader, FileMode::EXECUTABLE),
            ]),
            (400, invalid),
            "executable",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, ordinary),
                Entry::File("shader.frag", shader, ordinary),
                Entry::File("install.sh", b"rm -rf ~", ordinary),
            ]),
            (400, invalid),
            "install.sh",
        ),
        (
            archive(&[
                Entry::File("a/wallpaper.json", body, ordinary),
                Entry::File("b/shader.frag", shader, ordinary),
            ]),
            (400, invalid),
            "b/shader.frag",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, ordinary),
                Entry::File("shader.frag", long.as_bytes(), ordinary),
            ]),
            (413, "wallpaper_module_file_too_large"),
            "shader.frag must be at most 64 KB",
        ),
        (
            archive(&[
                Entry::File(
                    "wallpaper.json",
                    manifest("butler.rain").as_bytes(),
                    ordinary,
                ),
                Entry::File("shader.frag", shader, ordinary),
            ]),
            (400, "wallpaper_module_invalid"),
            "reserved",
        ),
    ];
    for (bytes, expected, named) in cases {
        let refused =
            s.gw.upload_file(IMPORT, "rain.zip", "application/zip", &bytes)
                .await?;
        assert_eq!(failure(&refused), expected, "{named}: {}", refused.text);
        assert!(
            message(&refused).contains(named),
            "{named}: {}",
            refused.text
        );
    }
    let mut large = archive(&[Entry::File("wallpaper.json", body, ordinary)]);
    large.resize(3 * 1024 * 1024, 0);
    let refused =
        s.gw.upload_file(IMPORT, "rain.zip", "application/zip", &large)
            .await?;
    assert_eq!(
        failure(&refused),
        (413, "wallpaper_module_archive_too_large")
    );
    assert_eq!(module_ids(&s.gw).await?, Vec::<String>::new());
    assert_eq!(
        files(&s.sandbox.data.join("wallpapers")),
        Vec::<String>::new()
    );
    assert!(!s.sandbox.data.join("shader.frag").exists());
    assert!(!s.sandbox.root.join("shader.frag").exists());

    let valid = archive(&[
        Entry::File("rain/wallpaper.json", body, ordinary),
        Entry::File("rain/shader.frag", shader, ordinary),
    ]);
    let imported =
        s.gw.upload_file(IMPORT, "rain.zip", "application/zip", &valid)
            .await?;
    assert_eq!(imported.status, 201, "{}", imported.text);
    assert_eq!(module_ids(&s.gw).await?, ["user.rain"]);
    assert_eq!(
        files(&s.sandbox.data.join("wallpapers")),
        ["user.rain/shader.frag", "user.rain/wallpaper.json"]
    );
    s.finish().await
}

/// WALL-03 — The agent's module save accepts only ids inside the contract
/// (never a path, never a reserved `butler.*` id) and writes nothing when
/// it refuses. A user module whose shader is a link to a file outside its
/// folder is listed as an error and its shader is never served. Built-in
/// modules cannot be deleted.
#[tokio::test]
async fn wall_03_module_ids_and_files_stay_inside_the_module_folder() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WALL-03")?.start().await?;
    let root = s.sandbox.data.join("wallpapers");
    for id in ["../escape", "butler.rain", "Rain", "user/rain"] {
        let request = json!({"id": id, "manifest": serde_json::from_str::<Value>(&manifest(id)).unwrap(), "shader": FRAGMENT});
        let refused = s.gw.post("/internal/wallpaper-modules", request).await?;
        assert_eq!(
            (refused.status, refused.body["error"]["field"].as_str()),
            (400, Some("id")),
            "{id}: {}",
            refused.text
        );
    }
    assert_eq!(files(&root), Vec::<String>::new());
    assert!(!s.sandbox.data.join("escape").exists());

    let outside = s.sandbox.root.join("outside.frag");
    std::fs::write(&outside, "void main(){/*outside*/}")?;
    let folder = root.join("user.linked");
    std::fs::create_dir_all(&folder)?;
    std::fs::write(folder.join("wallpaper.json"), manifest("user.linked"))?;
    secure_fs::symlink(&outside, &folder.join("shader.frag"))?;
    let shader = s.gw.get("/wallpaper-modules/user.linked/shader").await?;
    assert_ne!(shader.status, 200, "{}", shader.text);
    assert!(!shader.text.contains("outside"), "{}", shader.text);
    let listed = s.gw.get("/wallpaper-modules").await?;
    let linked = listed.data()["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|module| module["id"] == "user.linked")
        .cloned()
        .unwrap_or_else(|| panic!("user.linked not listed: {}", listed.text));
    assert!(
        linked.to_string().contains("not a link"),
        "linked shader should be an error: {linked}"
    );

    let builtin = s.gw.delete("/wallpaper-modules/butler.bloom").await?;
    assert_eq!(failure(&builtin), (400, "wallpaper_module_builtin"));
    s.finish().await
}

/// WALL-04 — Settings refuse a wallpaper outside the contract, naming the
/// offending field and changing nothing. A legacy theme patch re-derives
/// the wallpaper until one is chosen through `wallpaper`; after that a
/// legacy patch never overwrites it, across a restart too.
#[tokio::test]
async fn wall_04_settings_wallpaper_is_validated_and_legacy_patches_yield()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WALL-04")?.start().await?;
    let before = s.gw.get("/settings").await?.text;
    for (wallpaper, field) in [
        (json!("bloom"), "wallpaper"),
        (
            json!({"source": {"kind": "video"}}),
            "wallpaper.source.kind",
        ),
        (
            json!({"source": {"kind": "live", "module": "../bloom"}}),
            "wallpaper.source.module",
        ),
        (
            json!({"source": {"kind": "live", "module": "butler.bloom", "params": {"Speed": 1}}}),
            "wallpaper.source.params",
        ),
        (
            json!({"source": {"kind": "image", "asset": "../../app.sqlite", "fit": "cover", "dim": 0.25, "blur": 0}}),
            "wallpaper.source.asset",
        ),
    ] {
        let refused =
            s.gw.patch(
                "/settings",
                json!({"main_screen_theme": "silk", "wallpaper": wallpaper}),
            )
            .await?;
        assert_eq!(
            failure(&refused),
            (400, "settings_wallpaper_invalid"),
            "{wallpaper}: {}",
            refused.text
        );
        assert!(
            message(&refused).contains(field),
            "{field}: {}",
            refused.text
        );
    }
    assert_eq!(s.gw.get("/settings").await?.text, before);

    let custom = [
        "#102030", "#405060", "#708090", "#a0b0c0", "#d0e0f0", "#010203",
    ];
    let derived = s
        .gw
        .patch(
            "/settings",
            json!({"main_screen_theme_preset": "custom", "main_screen_theme_custom_colors": custom}),
        )
        .await?;
    assert_eq!(derived.status, 200, "{}", derived.text);
    assert_eq!(
        derived.data()["wallpaper"]["source"],
        json!({"kind": "live", "module": "butler.bloom", "params": {"colors": custom}})
    );

    let chosen = json!({"source": {"kind": "none"}, "motion": "paused", "pauseOnBattery": true});
    let patched =
        s.gw.patch("/settings", json!({"wallpaper": chosen}))
            .await?;
    assert_eq!(patched.status, 200, "{}", patched.text);
    assert_eq!(patched.data()["wallpaper"], chosen);
    let legacy =
        s.gw.patch(
            "/settings",
            json!({"main_screen_theme": "silk", "main_screen_theme_preset": "monochrome"}),
        )
        .await?;
    assert_eq!(legacy.status, 200, "{}", legacy.text);
    assert_eq!(legacy.data()["main_screen_theme"], "silk");
    assert_eq!(legacy.data()["wallpaper"], chosen);
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["wallpaper"], chosen);
    s.finish().await
}
