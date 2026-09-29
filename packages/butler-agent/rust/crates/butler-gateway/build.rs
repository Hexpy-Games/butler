//! Bundles the built-in wallpaper module manifests from the UI package, their
//! single source of truth: every `<id>/wallpaper.json` under the design
//! system's `Wallpaper/modules` folder becomes one entry of
//! `$OUT_DIR/wallpaper-modules.json`, a JSON array of
//! `{"folder": "<id>", "manifest": "<wallpaper.json text>"}`. A new module
//! folder is picked up by the next build; nothing is listed by hand.
//!
//! The build reads outside this crate on purpose: it needs the monorepo's
//! `packages/butler-app` next to `packages/butler-agent` (the UI owns the
//! modules), and fails when that folder is missing. Every bundled manifest
//! must pass the gateway's own contract check (the same `manifest` module,
//! compiled into this script) and name its folder, or the build fails with
//! the folder and the broken rules; a built-in never disappears silently.

use std::{
    env,
    error::Error,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

#[allow(
    dead_code,
    unused_imports,
    reason = "the build checks manifests; the gateway uses the rest of the module"
)]
#[path = "src/gateway/wallpaper_modules/manifest.rs"]
mod manifest;

const MODULES: &str =
    "../../../../butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules";

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={MODULES}");
    println!("cargo:rerun-if-changed=src/gateway/wallpaper_modules/manifest.rs");
    println!("cargo:rerun-if-changed=src/gateway/wallpaper_modules/manifest/rendering.rs");
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
    let mut broken = Vec::new();
    let mut entries = Vec::new();
    for (folder, manifest) in folders {
        let text = fs::read_to_string(manifest)?;
        match manifest::parse(&text) {
            Ok(module) if module.id == folder => {}
            Ok(module) => broken.push(format!("{folder}: id {} must name its folder", module.id)),
            Err(errors) => broken.push(format!("{folder}: {}", errors.join("; "))),
        }
        entries.push(format!(
            "{{\"folder\":{},\"manifest\":{}}}",
            string(&folder),
            string(&text)
        ));
    }
    if !broken.is_empty() {
        return Err(format!("invalid built-in wallpaper modules: {}", broken.join(" | ")).into());
    }
    Ok(entries)
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
