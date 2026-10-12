//! The persisted memory-model choice: `memory.embeddings` (on or off) in butler.config.json.
//! Absent means unset; nothing downloads until the user chooses.
use super::{MODEL_ROOT, STAGING, complete, part_path, pinned_assets, reject_symlink};
use butler_core::configuration::{lock_file, read_json_object, write_json_atomic};
use butler_memory::cognition::ensure_data_authority;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

const CONFIG: &str = "butler.config.json";
const UNSAVED: &str = "memory_model_choice_unsaved";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Choice {
    Unset,
    On,
    Off,
}

impl Choice {
    /// The readiness state shown when no download runs.
    pub(crate) fn idle_state(self) -> &'static str {
        match self {
            Self::Unset => "unset",
            Self::Off => "off",
            Self::On => "queued",
        }
    }
}

/// An explicit choice wins. Installs that already hold the model, or began its
/// download before the choice existed, keep it on. Metadata probes only.
pub(crate) fn read(data_root: &Path) -> (Choice, bool) {
    let root = data_root.join(MODEL_ROOT);
    let assets = pinned_assets();
    let ready = complete(&root, &assets);
    let stored = read_json_object(&data_root.join(CONFIG))
        .ok()
        .and_then(|config| {
            config
                .pointer("/memory/embeddings")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let started = || {
        assets
            .iter()
            .any(|asset| part_path(&root.join(STAGING), asset).is_file())
    };
    let choice = match stored.as_deref() {
        Some("on") => Choice::On,
        Some("off") => Choice::Off,
        _ if ready || started() => Choice::On,
        _ => Choice::Unset,
    };
    (choice, ready)
}

/// One locked read-modify-write that keeps every other configuration key.
pub(crate) fn persist(data_root: &Path, on: bool) -> Result<(), &'static str> {
    let path = data_root.join(CONFIG);
    ensure_data_authority(data_root, &[&path]).map_err(|_| UNSAVED)?;
    let _lock = lock_file(&path).map_err(|_| UNSAVED)?;
    let mut config = read_json_object(&path).map_err(|_| UNSAVED)?;
    let value = json!(if on { "on" } else { "off" });
    match config.get_mut("memory").and_then(Value::as_object_mut) {
        Some(memory) => {
            memory.insert("embeddings".into(), value);
        }
        None => config["memory"] = json!({ "embeddings": value }),
    }
    write_json_atomic(&path, &config).map_err(|_| UNSAVED)
}

/// Off frees the re-downloadable model files (about 587 MB) and any partials.
/// Stored vectors stay: they cost hours of CPU to rebuild, and only the gap is
/// embedded when the model returns. The caller has already reaped the worker.
pub(crate) fn remove_model(data_root: &Path) -> Result<(), &'static str> {
    let root = data_root.join(MODEL_ROOT);
    let staging = root.join(STAGING);
    let mut paths = Vec::new();
    for asset in &pinned_assets() {
        paths.push(root.join(&asset.relative));
        paths.push(part_path(&staging, asset));
    }
    let guarded = paths.iter().map(PathBuf::as_path).collect::<Vec<_>>();
    ensure_data_authority(data_root, &guarded).map_err(|_| "embed_asset_path_unsafe")?;
    for path in &paths {
        reject_symlink(path)?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("embed_asset_unavailable"),
        }
    }
    Ok(())
}
