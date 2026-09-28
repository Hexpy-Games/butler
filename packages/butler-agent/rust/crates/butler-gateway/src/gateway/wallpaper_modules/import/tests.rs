use std::{
    fs,
    io::{Cursor, Write},
};

use serde_json::{Value, json};
use zip::{ZipWriter, write::SimpleFileOptions};

use super::*;
use crate::gateway::wallpaper_modules::user::{
    self,
    tests::{FRAGMENT, manifest, root},
};

/// One archive entry: a file with its unix mode, or a symbolic link.
pub(in crate::gateway) enum Entry<'a> {
    File(&'a str, &'a [u8], u32),
    Link(&'a str, &'a str),
}

pub(in crate::gateway) fn archive(entries: &[Entry<'_>]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for entry in entries {
        match entry {
            Entry::File(name, bytes, mode) => {
                let options = SimpleFileOptions::default().unix_permissions(*mode);
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            Entry::Link(name, target) => {
                writer
                    .add_symlink(*name, *target, SimpleFileOptions::default())
                    .unwrap();
            }
        }
    }
    writer.finish().unwrap().into_inner()
}

/// A valid module archive, its files under `prefix` (e.g. `"rain/"` or `""`).
pub(in crate::gateway) fn module_archive(id: &str, prefix: &str) -> Vec<u8> {
    let manifest = manifest(id);
    let names = [
        format!("{prefix}wallpaper.json"),
        format!("{prefix}shader.frag"),
    ];
    archive(&[
        Entry::File(&names[0], manifest.as_bytes(), 0o644),
        Entry::File(&names[1], FRAGMENT.as_bytes(), 0o644),
    ])
}

fn refused(archive: &[u8]) -> (u16, String, String) {
    match unpack(archive) {
        Ok(unpacked) => panic!("accepted {}", unpacked.module.id),
        Err(GatewayApplicationError::Public {
            status,
            code,
            message,
            ..
        }) => (status, code, message),
        Err(other) => panic!("expected a public error, got {other:?}"),
    }
}

#[test]
fn a_module_archive_unpacks_from_the_top_or_one_folder() {
    let unpacked = unpack(&module_archive("user.rain", "")).unwrap();
    assert_eq!(unpacked.module.id, "user.rain");
    let nested = unpack(&module_archive("user.rain", "rain-v2/")).unwrap();
    assert_eq!(nested.module.id, "user.rain");
    let manifest = manifest("user.rain");
    let png = b"\x89PNG\r\n\x1a\n0000";
    let with_extras = archive(&[
        Entry::File("rain/", b"", 0o755),
        Entry::File("rain/wallpaper.json", manifest.as_bytes(), 0o644),
        Entry::File("rain/shader.frag", FRAGMENT.as_bytes(), 0o644),
        Entry::File("rain/thumbnail.png", png, 0o644),
        Entry::File("rain/.DS_Store", b"finder", 0o644),
        Entry::File("__MACOSX/rain/._shader.frag", b"fork", 0o644),
    ]);
    let unpacked = unpack(&with_extras).unwrap();
    let names: Vec<_> = unpacked
        .files
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(names, ["wallpaper.json", "shader.frag", "thumbnail.png"]);
}

#[test]
fn unsafe_or_unexpected_entries_are_refused_by_name() {
    let manifest = manifest("user.rain");
    let body = manifest.as_bytes();
    let shader = FRAGMENT.as_bytes();
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (
            archive(&[
                Entry::File("wallpaper.json", body, 0o644),
                Entry::File("../shader.frag", shader, 0o644),
            ]),
            "../shader.frag",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, 0o644),
                Entry::File("/etc/shader.frag", shader, 0o644),
            ]),
            "/etc/shader.frag",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, 0o644),
                Entry::Link("shader.frag", "/etc/passwd"),
            ]),
            "symbolic link",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, 0o644),
                Entry::File("shader.frag", shader, 0o755),
            ]),
            "executable",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, 0o644),
                Entry::File("shader.frag", shader, 0o644),
                Entry::File("install.sh", b"rm -rf ~", 0o644),
            ]),
            "install.sh",
        ),
        (
            archive(&[
                Entry::File("a/wallpaper.json", body, 0o644),
                Entry::File("b/shader.frag", shader, 0o644),
            ]),
            "b/shader.frag",
        ),
        (
            archive(&[
                Entry::File("rain/deep/wallpaper.json", body, 0o644),
                Entry::File("rain/deep/shader.frag", shader, 0o644),
            ]),
            "rain/deep/wallpaper.json",
        ),
        (
            archive(&[
                Entry::File("wallpaper.json", body, 0o644),
                Entry::File("shader.frag", shader, 0o644),
                Entry::File("thumbnail.png", b"GIF89a", 0o644),
            ]),
            "thumbnail.png",
        ),
        (
            archive(&[Entry::File("wallpaper.json", body, 0o644)]),
            "shader.frag is missing",
        ),
        (b"PK\x03\x04 not really".to_vec(), "zip"),
    ];
    for (bytes, expected) in cases {
        let (status, code, message) = refused(&bytes);
        assert_eq!(
            (status, code.as_str()),
            (400, "wallpaper_module_archive_invalid"),
            "{expected}: {message}"
        );
        assert!(message.contains(expected), "{expected}: {message}");
    }
}

#[test]
fn archives_and_files_over_their_limits_are_refused() {
    let mut big = module_archive("user.rain", "");
    big.resize(MAX_ARCHIVE_BYTES + 1, 0);
    let (status, code, _) = refused(&big);
    assert_eq!(
        (status, code.as_str()),
        (413, "wallpaper_module_archive_too_large")
    );
    let manifest = manifest("user.rain");
    let long = " ".repeat(user::MAX_SHADER_BYTES + 1);
    let oversized = archive(&[
        Entry::File("wallpaper.json", manifest.as_bytes(), 0o644),
        Entry::File("shader.frag", long.as_bytes(), 0o644),
    ]);
    let (status, code, message) = refused(&oversized);
    assert_eq!(
        (status, code.as_str()),
        (413, "wallpaper_module_file_too_large")
    );
    assert!(
        message.contains("shader.frag must be at most 64 KB"),
        "{message}"
    );
}

#[test]
fn a_manifest_that_breaks_the_contract_is_refused_with_its_rules() {
    for (id, expected) in [
        (
            "butler.rain",
            "id: butler.* ids are reserved for built-in modules",
        ),
        ("Rain", "id: must match"),
    ] {
        let (status, code, message) = refused(&module_archive(id, ""));
        assert_eq!((status, code.as_str()), (400, "wallpaper_module_invalid"));
        assert!(message.contains(expected), "{message}");
    }
}

#[test]
fn install_places_the_module_in_its_folder_replacing_an_older_copy() {
    let root = root("install");
    let first = unpack(&module_archive("user.rain", "")).unwrap();
    install(&root, &first, "0001").unwrap();
    let folder = root.join("user.rain");
    assert_eq!(
        fs::read_to_string(folder.join("shader.frag")).unwrap(),
        FRAGMENT
    );
    fs::write(folder.join("stale.txt"), "old").unwrap();
    install(&root, &first, "0002").unwrap();
    assert!(!folder.join("stale.txt").exists());
    let leftovers: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers, ["user.rain"]);
    assert!(
        user::read(&root, "user.rain")
            .unwrap()
            .unwrap()
            .module
            .is_ok()
    );

    assert!(remove(&root, "user.rain", "0003").unwrap());
    assert!(!remove(&root, "user.rain", "0004").unwrap());
    assert!(!remove(&root, "../outside", "0005").unwrap());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_archive_may_carry_an_overlay_and_the_image_its_manifest_names() {
    let mut scene: Value = serde_json::from_str(&manifest("user.scene")).unwrap();
    scene["image"] = json!("optional");
    scene["overlay"] = json!(true);
    scene["defaultImage"] = json!("photo.webp");
    let scene = scene.to_string();
    let webp = b"RIFF\0\0\0\0WEBPVP8 ";
    let with = |image: Entry<'_>| {
        archive(&[
            Entry::File("wallpaper.json", scene.as_bytes(), 0o644),
            Entry::File("shader.frag", FRAGMENT.as_bytes(), 0o644),
            Entry::File("overlay.frag", FRAGMENT.as_bytes(), 0o644),
            image,
        ])
    };
    let unpacked = unpack(&with(Entry::File("photo.webp", webp, 0o644))).unwrap();
    let names: Vec<_> = unpacked
        .files
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "wallpaper.json",
            "shader.frag",
            "overlay.frag",
            "photo.webp"
        ]
    );
    let (status, code, message) = refused(&with(Entry::File("other.png", webp, 0o644)));
    assert_eq!(
        (status, code.as_str()),
        (400, "wallpaper_module_archive_invalid")
    );
    assert!(message.contains("Archive entry other.png"), "{message}");
    let big = vec![0u8; user::MAX_IMAGE_BYTES + 1];
    let (status, _, message) = refused(&with(Entry::File("photo.webp", &big, 0o644)));
    assert_eq!(status, 413);
    assert!(
        message.contains("photo.webp must be at most 1 MB"),
        "{message}"
    );
    let (_, code, message) = refused(&with(Entry::File("photo.webp", b"GIF89a", 0o644)));
    assert_eq!(code, "wallpaper_module_invalid");
    assert!(
        message.contains("must be a JPEG, PNG or WebP image"),
        "{message}"
    );
}
