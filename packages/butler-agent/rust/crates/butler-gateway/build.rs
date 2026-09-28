//! Bundles the built-in wallpaper module manifests from the UI package, their
//! single source of truth: every `<id>/wallpaper.json` under the design
//! system's `Wallpaper/modules` folder becomes one entry of
//! `$OUT_DIR/wallpaper-modules.json`, a JSON array of
//! `{"folder": "<id>", "manifest": "<wallpaper.json text>"}`. A new module
//! folder is picked up by the next build; nothing is listed by hand. The
//! gateway parses and validates each manifest (`gateway::wallpaper_modules`),
//! so one malformed file cannot hide the others.

use std::{
    env,
    error::Error,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

const MODULES: &str =
    "../../../../butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules";

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={MODULES}");
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join(MODULES);
    let entries = entries(&root)
        .map_err(|error| format!("wallpaper modules at {}: {error}", root.display()))?;
    let bundle = format!("[{}]", entries.join(",\n"));
    let target = PathBuf::from(env::var("OUT_DIR")?).join("wallpaper-modules.json");
    // Rewriting identical bytes would rebuild the crate on every shader edit.
    if fs::read_to_string(&target).ok().as_deref() != Some(bundle.as_str()) {
        fs::write(&target, bundle)?;
    }
    Ok(())
}

/// One entry per module folder holding a `wallpaper.json`, by folder name.
fn entries(root: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let mut folders = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let manifest = entry.path().join("wallpaper.json");
        if entry.file_type()?.is_dir() && manifest.is_file() {
            folders.push((entry.file_name().to_string_lossy().into_owned(), manifest));
        }
    }
    folders.sort();
    folders
        .into_iter()
        .map(|(folder, manifest)| {
            let text = fs::read_to_string(manifest)?;
            Ok(format!(
                "{{\"folder\":{},\"manifest\":{}}}",
                string(&folder),
                string(&text)
            ))
        })
        .collect()
}

/// `text` as a JSON string literal.
fn string(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            control if u32::from(control) < 0x20 => {
                let _ = write!(quoted, "\\u{:04x}", u32::from(control));
            }
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}
