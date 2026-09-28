use std::{fs, path::PathBuf};

use serde_json::{Value, json};

use super::*;

pub(in crate::gateway) fn manifest(id: &str) -> String {
    json!({
        "id": id, "name": {"en": "Rain", "ko": "비"}, "version": "1.0.0", "engine": 1,
        "motion": "animated", "image": "none",
        "params": [{"key": "speed", "label": {"en": "Speed", "ko": "속도"}, "type": "number",
                    "min": 0, "max": 1, "step": 0.1, "default": 0.5}]
    })
    .to_string()
}

pub(in crate::gateway) const FRAGMENT: &str = "void main(){fragColor=vec4(vec3(p_speed),1.);}";

/// A fresh module root under the system temp directory.
pub(in crate::gateway) fn root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "butler-user-modules-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

/// Writes `<root>/<folder>/wallpaper.json` and, when given, `shader.frag`.
pub(in crate::gateway) fn write(root: &Path, folder: &str, manifest: &str, shader: Option<&str>) {
    let folder = root.join(folder);
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join(MANIFEST), manifest).unwrap();
    if let Some(shader) = shader {
        fs::write(folder.join(SHADER), shader).unwrap();
    }
}

/// Why a module serves no shader.
#[derive(Debug)]
enum ShaderError {
    NotFound,
    Invalid(String),
}

fn shader(root: &Path, id: &str) -> Result<(String, String), ShaderError> {
    let module = read(root, id).unwrap().ok_or(ShaderError::NotFound)?;
    match (&module.module, module.shader()) {
        (Ok(_), Some(text)) => Ok((text.to_owned(), module.revision.clone())),
        (Err(reason), _) => Err(ShaderError::Invalid(reason.clone())),
        (Ok(_), None) => panic!("a valid module has a shader"),
    }
}

fn error(module: &UserModule) -> &str {
    module.module.as_ref().unwrap_err()
}

fn found<'a>(modules: &'a [UserModule], id: &str) -> &'a UserModule {
    modules.iter().find(|module| module.id == id).unwrap()
}

#[test]
fn folders_are_listed_by_name_and_only_valid_modules_are_usable() {
    let root = root("scan");
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    write(&root, "user.moss", &manifest("user.fern"), Some(FRAGMENT));
    write(&root, "butler.fog", &manifest("butler.fog"), Some(FRAGMENT));
    write(
        &root,
        "butler.bloom",
        &manifest("butler.bloom"),
        Some(FRAGMENT),
    );
    write(&root, "user.dry", &manifest("user.dry"), None);
    write(&root, "user.broken", "{ not json", Some(FRAGMENT));
    write(
        &root,
        ".import-0001",
        &manifest("user.rain"),
        Some(FRAGMENT),
    );
    fs::write(root.join("notes.txt"), "ignored").unwrap();

    let modules = scan(&root).unwrap();
    let ids: Vec<_> = modules.iter().map(|module| module.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "butler.bloom",
            "butler.fog",
            "user.broken",
            "user.dry",
            "user.moss",
            "user.rain"
        ]
    );
    let rain = found(&modules, "user.rain");
    assert_eq!(rain.module.as_ref().unwrap().id, "user.rain");
    assert_eq!(rain.revision.len(), 32);
    assert!(error(found(&modules, "user.moss")).contains("id: must name its folder user.moss"));
    let reserved = "id: butler.* ids are reserved for built-in modules";
    assert!(error(found(&modules, "butler.fog")).contains(reserved));
    assert!(error(found(&modules, "butler.bloom")).contains(reserved));
    assert!(error(found(&modules, "user.dry")).contains("shader.frag: missing"));
    assert!(error(found(&modules, "user.broken")).starts_with("manifest: invalid JSON"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn oversized_non_text_and_linked_files_are_errors() {
    let root = root("limits");
    let padded = format!("{}{}", manifest("user.big"), " ".repeat(MAX_MANIFEST_BYTES));
    write(&root, "user.big", &padded, Some(FRAGMENT));
    let long = format!("{FRAGMENT}\n//{}", "x".repeat(MAX_SHADER_BYTES));
    write(&root, "user.long", &manifest("user.long"), Some(&long));
    write(&root, "user.binary", &manifest("user.binary"), None);
    fs::write(root.join("user.binary").join(SHADER), [0xff, 0xfe, 0x00]).unwrap();
    write(&root, "user.linked", &manifest("user.linked"), None);
    let outside = root.join("outside.frag");
    fs::write(&outside, FRAGMENT).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("user.linked").join(SHADER)).unwrap();
    write(&root, "user.real", &manifest("user.alias"), Some(FRAGMENT));
    std::os::unix::fs::symlink(root.join("user.real"), root.join("user.alias")).unwrap();

    let modules = scan(&root).unwrap();
    assert!(error(found(&modules, "user.big")).contains("wallpaper.json: must be at most 32 KB"));
    assert!(error(found(&modules, "user.long")).contains("shader.frag: must be at most 64 KB"));
    assert!(error(found(&modules, "user.binary")).contains("shader.frag: must be UTF-8 text"));
    assert!(
        error(found(&modules, "user.linked")).contains("shader.frag: must be a file, not a link")
    );
    assert!(error(found(&modules, "user.alias")).contains("must be a folder, not a link"));
    assert!(matches!(
        shader(&root, "user.linked"),
        Err(ShaderError::Invalid(_))
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_module_revision_follows_both_files_and_the_shader_is_served_only_when_valid() {
    let root = root("revision");
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    let first = read(&root, "user.rain").unwrap().unwrap();
    assert_eq!(
        read(&root, "user.rain").unwrap().unwrap().revision,
        first.revision
    );
    let (text, revision) = shader(&root, "user.rain").unwrap();
    assert_eq!(
        (text.as_str(), revision.as_str()),
        (FRAGMENT, first.revision.as_str())
    );

    fs::write(root.join("user.rain").join(SHADER), "void main(){}").unwrap();
    let edited = read(&root, "user.rain").unwrap().unwrap();
    assert_ne!(edited.revision, first.revision);
    let renamed = manifest("user.rain").replace("Rain", "Drizzle");
    fs::write(root.join("user.rain").join(MANIFEST), renamed).unwrap();
    assert_ne!(
        read(&root, "user.rain").unwrap().unwrap().revision,
        edited.revision
    );

    for missing in ["user.none", "../user.rain", ".import-1", "", "a/b"] {
        assert!(read(&root, missing).unwrap().is_none(), "{missing}");
        assert!(
            matches!(shader(&root, missing), Err(ShaderError::NotFound)),
            "{missing}"
        );
    }
    write(&root, "user.moss", &manifest("user.fern"), Some(FRAGMENT));
    let Err(ShaderError::Invalid(message)) = shader(&root, "user.moss") else {
        panic!("an invalid module serves no shader");
    };
    assert!(message.contains("must name its folder"), "{message}");
    fs::remove_dir_all(root).unwrap();
}

fn stored(revision: &str, state: &str, message: Option<&str>) -> ModuleStatus {
    ModuleStatus {
        revision: revision.into(),
        state: state.into(),
        message: message.map(str::to_owned),
        checked_at: "2026-09-28T00:00:00.000Z".into(),
    }
}

#[test]
fn entries_carry_the_manifest_source_and_status_of_the_current_files() {
    let root = root("entries");
    write(&root, "user.rain", &manifest("user.rain"), Some(FRAGMENT));
    write(&root, "user.moss", &manifest("user.fern"), Some(FRAGMENT));
    let rain = read(&root, "user.rain").unwrap().unwrap();
    let authored: Value = serde_json::from_str(&manifest("user.rain")).unwrap();

    let entry = rain.entry(None);
    let mut expected = authored.clone();
    expected["source"] = json!("user");
    expected["status"] = json!({"state": "unknown"});
    assert_eq!(entry, expected);
    let current = stored(&rain.revision, "error", Some("0:1: syntax error"));
    assert_eq!(
        rain.entry(Some(&current))["status"],
        json!({"state": "error", "message": "0:1: syntax error",
               "checkedAt": "2026-09-28T00:00:00.000Z"})
    );
    let checked = stored(&rain.revision, "ok", None);
    assert_eq!(
        rain.entry(Some(&checked))["status"],
        json!({"state": "ok", "checkedAt": "2026-09-28T00:00:00.000Z"})
    );
    let stale = stored("0000", "error", Some("old"));
    assert_eq!(
        rain.entry(Some(&stale))["status"],
        json!({"state": "unknown"})
    );

    let moss = read(&root, "user.moss").unwrap().unwrap();
    let entry = moss.entry(Some(&stored(&moss.revision, "ok", None)));
    assert_eq!(entry["id"], "user.moss");
    assert_eq!(entry["name"], json!({"en": "Rain", "ko": "비"}));
    assert_eq!(entry["source"], "user");
    assert_eq!(entry["status"]["state"], "error");
    assert!(
        entry["status"]["message"]
            .as_str()
            .unwrap()
            .contains("id: must name its folder user.moss")
    );
    assert!(entry.get("params").is_none());
    fs::write(root.join("user.moss").join(MANIFEST), "[]").unwrap();
    let nameless = read(&root, "user.moss").unwrap().unwrap().entry(None);
    assert_eq!(
        nameless["name"],
        json!({"en": "user.moss", "ko": "user.moss"})
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn overlays_and_default_images_are_checked_hashed_and_kept() {
    let root = root("extras");
    let mut scene: Value = serde_json::from_str(&manifest("user.scene")).unwrap();
    scene["image"] = json!("required");
    scene["overlay"] = json!(true);
    scene["defaultImage"] = json!("photo.jpg");
    write(&root, "user.scene", &scene.to_string(), Some(FRAGMENT));
    let folder = root.join("user.scene");
    let module = |root: &Path| read(root, "user.scene").unwrap().unwrap();
    let message = error(&module(&root)).to_owned();
    assert!(
        message.contains("overlay.frag: required by overlay: true"),
        "{message}"
    );
    assert!(
        message.contains("defaultImage: photo.jpg is not in the module folder"),
        "{message}"
    );
    fs::write(folder.join(OVERLAY), FRAGMENT).unwrap();
    fs::write(folder.join("photo.jpg"), b"GIF89a").unwrap();
    let rule = "defaultImage: photo.jpg must be a JPEG, PNG or WebP image";
    assert!(error(&module(&root)).contains(rule));
    fs::write(folder.join("photo.jpg"), vec![0xff; MAX_IMAGE_BYTES + 1]).unwrap();
    let rule = "defaultImage: photo.jpg must be at most 1 MB";
    assert!(error(&module(&root)).contains(rule));

    let jpeg = b"\xff\xd8\xff\xe0 jpeg";
    fs::write(folder.join("photo.jpg"), jpeg).unwrap();
    let valid = module(&root);
    assert_eq!(valid.overlay(), Some(FRAGMENT));
    let image = valid.image().unwrap();
    assert_eq!(
        (image.mime_type, image.bytes.as_slice()),
        ("image/jpeg", &jpeg[..])
    );
    assert_eq!(
        existing_image(&root, "user.scene", "photo.jpg").unwrap(),
        FileRead::Bytes(jpeg.to_vec())
    );
    fs::write(folder.join(OVERLAY), "void main(){fragColor=vec4(1.);}").unwrap();
    let overlaid = module(&root).revision;
    assert_ne!(overlaid, valid.revision);
    fs::write(folder.join("photo.jpg"), b"\xff\xd8\xff\xe1 other").unwrap();
    assert_ne!(module(&root).revision, overlaid);

    // An overlay without "overlay": true would never be drawn.
    write(&root, "user.plain", &manifest("user.plain"), Some(FRAGMENT));
    fs::write(root.join("user.plain").join(OVERLAY), FRAGMENT).unwrap();
    let plain = read(&root, "user.plain").unwrap().unwrap();
    assert!(error(&plain).contains("overlay.frag: set overlay: true in wallpaper.json"));
    fs::remove_dir_all(root).unwrap();
}
