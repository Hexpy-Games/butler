//! Source-compatible operator access to canonical Box manifests and index.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;

use crate::cognition::CognitionResult;

use super::{BoxStoreService, error, index, manifest, paths};
use crate::cognition::CognitionCode;

/// `box show`: the item row and its full manifest.
#[derive(Serialize)]
struct ShowResponse<'a> {
    item: ItemSummary<'a>,
    manifest: &'a manifest::BoxManifest,
}

/// `box inspect`: `show` plus the text of box-owned files when asked.
#[derive(Serialize)]
struct InspectResponse<'a> {
    item: ItemSummary<'a>,
    manifest: &'a manifest::BoxManifest,
    raw: Vec<RawFile<'a>>,
}

/// A box-owned file's text; `None` when the file is gone.
#[derive(Serialize)]
struct RawFile<'a> {
    role: &'a str,
    box_relative_path: &'a str,
    text: Option<String>,
}

/// `box forget`: the forgotten item row and the forget mode.
#[derive(Serialize)]
struct ForgetResponse<'a> {
    item: ItemSummary<'a>,
    mode: &'a str,
}

/// Which parts of an item `box forget` removes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ForgetMode {
    /// Delete the box-owned files, then mark the item forgotten.
    Raw,
    /// Only mark the item forgotten.
    Manifest,
}

impl BoxStoreService {
    /// The first `limit` rows of the item index.
    pub async fn operator_list(&self, limit: usize) -> CognitionResult<Vec<Value>> {
        self.with_lease("box_operator_list", move |root| {
            index::list_indexed(&root, limit)
        })
        .await
    }

    /// The item's summary and manifest, or `None` when it does not exist.
    pub async fn operator_show(&self, id: &str) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("box_operator_show", move |root| {
            let Some(manifest) = read_manifest(&root, &id)? else {
                return Ok(None);
            };
            response(
                &ShowResponse {
                    item: item_summary(&manifest),
                    manifest: &manifest,
                },
                CognitionCode::MemoryBoxManifestInvalid,
            )
            .map(Some)
        })
        .await
    }

    /// Like [`Self::operator_show`], plus the text of box-owned files when
    /// `include_raw` is set.
    pub async fn operator_inspect(
        &self,
        id: &str,
        include_raw: bool,
    ) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("box_operator_inspect", move |root| {
            let Some(manifest) = read_manifest(&root, &id)? else {
                return Ok(None);
            };
            let item_dir = root.join("items").join(&id);
            let raw = if include_raw {
                raw_files(&manifest, &item_dir)?
            } else {
                Vec::new()
            };
            response(
                &InspectResponse {
                    item: item_summary(&manifest),
                    manifest: &manifest,
                    raw,
                },
                CognitionCode::MemoryBoxManifestInvalid,
            )
            .map(Some)
        })
        .await
    }

    /// Marks the item forgotten; mode `raw` also deletes its box-owned files.
    pub async fn operator_forget(&self, id: &str, mode: &str) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        let mode = mode.to_owned();
        let forget = if mode == "raw" {
            ForgetMode::Raw
        } else {
            ForgetMode::Manifest
        };
        self.with_lease("box_operator_forget", move |root| {
            let Some(mut manifest) = read_manifest(&root, &id)? else {
                return Ok(None);
            };
            let item_dir = root.join("items").join(&id);
            if forget == ForgetMode::Raw {
                remove_box_owned_files(&manifest, &item_dir)?;
            }
            manifest.status = manifest::ItemStatus::Forgotten;
            manifest.updated_at = now_iso();
            manifest.quality.signals.push(format!("forgotten:{mode}"));
            let path = item_dir.join("manifest.json");
            let path = paths::validate_manifest_target(&path, &item_dir)?;
            manifest::write_manifest(&path, &manifest)?;
            response(
                &ForgetResponse {
                    item: item_summary(&manifest),
                    mode: &mode,
                },
                CognitionCode::MemoryBoxManifestWriteFailed,
            )
            .map(Some)
        })
        .await
    }
}

/// Box-owned files with a relative path, each validated inside the item.
fn box_owned_files<'a>(
    manifest: &'a manifest::BoxManifest,
    item_dir: &'a Path,
) -> impl Iterator<Item = CognitionResult<(&'a manifest::FileRef, &'a str, std::path::PathBuf)>> + 'a
{
    manifest
        .files
        .iter()
        .filter(|file| file.ownership == "box-owned")
        .filter_map(|file| Some((file, file.box_relative_path.as_deref()?)))
        .map(move |(file, relative)| {
            paths::validate_relative_file(item_dir, relative).map(|path| (file, relative, path))
        })
}

fn raw_files<'a>(
    manifest: &'a manifest::BoxManifest,
    item_dir: &'a Path,
) -> CognitionResult<Vec<RawFile<'a>>> {
    box_owned_files(manifest, item_dir)
        .map(|entry| {
            let (file, relative, path) = entry?;
            let text = match fs::read(&path) {
                Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err(error(CognitionCode::MemoryBoxContentReadFailed)),
            };
            Ok(RawFile {
                role: &file.role,
                box_relative_path: relative,
                text,
            })
        })
        .collect()
}

fn remove_box_owned_files(manifest: &manifest::BoxManifest, item_dir: &Path) -> CognitionResult<()> {
    for entry in box_owned_files(manifest, item_dir) {
        let (_, _, path) = entry?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error(CognitionCode::MemoryBoxContentRemoveFailed)),
        }
    }
    Ok(())
}

fn response(body: &impl Serialize, code: CognitionCode) -> CognitionResult<Value> {
    serde_json::to_value(body).map_err(|source| error(code).with_source(source))
}

fn read_manifest(root: &Path, id: &str) -> CognitionResult<Option<manifest::BoxManifest>> {
    if !paths::safe_item_id(id) {
        return Err(error(CognitionCode::MemoryBoxManifestIdInvalid));
    }
    let item_dir = root.join("items").join(id);
    manifest::read_manifest_for_dir(root, &item_dir, id)
}

/// The index-row view of a manifest shown by operator commands.
#[derive(Serialize)]
struct ItemSummary<'a> {
    box_item_id: &'a str,
    kind: manifest::ItemKind,
    status: manifest::ItemStatus,
    title: &'a str,
    summary: &'a str,
    privacy_class: manifest::PrivacyClass,
    retention_class: manifest::RetentionClass,
    freshness_class: manifest::FreshnessClass,
    created_at: &'a str,
    captured_at: &'a str,
    updated_at: &'a str,
    tags: &'a [String],
    file_count: usize,
}

fn item_summary(manifest: &manifest::BoxManifest) -> ItemSummary<'_> {
    ItemSummary {
        box_item_id: &manifest.box_item_id,
        kind: manifest.kind,
        status: manifest.status,
        title: &manifest.title,
        summary: &manifest.summary,
        privacy_class: manifest.privacy.class_name,
        retention_class: manifest.retention.class_name,
        freshness_class: manifest.freshness.class_name,
        created_at: &manifest.created_at,
        captured_at: &manifest.captured_at,
        updated_at: &manifest.updated_at,
        tags: &manifest.tags,
        file_count: manifest.files.len(),
    }
}

fn now_iso() -> String {
    let millis = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128),
    )
    .unwrap_or(i64::MAX);
    butler_core::js_date::format_iso_millis(millis)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}
