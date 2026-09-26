use std::{
    fs::{self, OpenOptions},
    io::{BufReader, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::File;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::cognition::{CognitionError, CognitionResult};

use super::{error, paths};

pub(super) const ITEM_SCHEMA: &str = "butler.cognition.box.item.v1";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ItemKind {
    File,
    WebSnapshot,
    SourceSnapshot,
    ToolResult,
    WorkerArtifact,
    Report,
    Collection,
    ExternalRef,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ItemStatus {
    Pending,
    Indexed,
    Summarized,
    Linked,
    FailedRetryable,
    FailedTerminal,
    Forgotten,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum PrivacyClass {
    Public,
    Private,
    Sensitive,
    Secret,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RetentionClass {
    Working,
    Pinned,
    Archive,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum FreshnessClass {
    Unknown,
    Current,
    Stale,
    Historical,
}

macro_rules! enum_names {
    ($type:ty { $($variant:ident => $value:literal),+ $(,)? }) => {
        impl $type {
            pub(super) fn as_str(&self) -> &'static str {
                match self { $(Self::$variant => $value),+ }
            }
        }
    };
}

enum_names!(ItemKind {
    File => "file", WebSnapshot => "web_snapshot", SourceSnapshot => "source_snapshot",
    ToolResult => "tool_result", WorkerArtifact => "worker_artifact", Report => "report",
    Collection => "collection", ExternalRef => "external_ref",
});
enum_names!(ItemStatus {
    Pending => "pending", Indexed => "indexed", Summarized => "summarized", Linked => "linked",
    FailedRetryable => "failed_retryable", FailedTerminal => "failed_terminal", Forgotten => "forgotten",
});
enum_names!(PrivacyClass {
    Public => "public", Private => "private", Sensitive => "sensitive", Secret => "secret",
});
enum_names!(RetentionClass {
    Working => "working", Pinned => "pinned", Archive => "archive",
});
enum_names!(FreshnessClass {
    Unknown => "unknown", Current => "current", Stale => "stale", Historical => "historical",
});

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct BoxManifest {
    pub schema: String,
    pub box_item_id: String,
    pub collection_id: Option<String>,
    pub kind: ItemKind,
    pub status: ItemStatus,
    pub created_at: String,
    pub captured_at: String,
    pub updated_at: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub origin: Origin,
    pub source: Source,
    pub files: Vec<FileRef>,
    pub privacy: Privacy,
    pub retention: Retention,
    pub freshness: Freshness,
    pub refs: Refs,
    pub quality: Quality,
    pub citations: Vec<String>,
    pub provenance: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Origin {
    pub producer: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub message_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub worker_run_id: Option<String>,
    pub consolidation_run_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Source {
    pub uri: Option<String>,
    pub local_path: Option<String>,
    pub provider: Option<String>,
    pub fetched_at: Option<String>,
    pub observed_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct FileRef {
    pub role: String,
    pub path: Option<String>,
    pub box_relative_path: Option<String>,
    pub ownership: String,
    pub size_bytes: Option<f64>,
    pub sha256: Option<String>,
    pub mime_type: Option<String>,
    pub mtime: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Privacy {
    #[serde(rename = "class")]
    pub class_name: PrivacyClass,
    pub external_provider_allowed: bool,
    pub reason: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Retention {
    #[serde(rename = "class")]
    pub class_name: RetentionClass,
    pub pinned: bool,
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Freshness {
    #[serde(rename = "class")]
    pub class_name: FreshnessClass,
    pub source_timestamp: Option<String>,
    pub checked_at: Option<String>,
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Refs {
    pub memory_chunk_ids: Vec<String>,
    pub feedback_ids: Vec<String>,
    pub knowhow_ids: Vec<String>,
    pub graph_edge_ids: Vec<String>,
    pub parent_box_item_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Quality {
    pub score: Option<f64>,
    pub signals: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub(super) fn read_manifest_for_dir(
    root: &Path,
    item_dir: &Path,
    expected_id: &str,
) -> CognitionResult<Option<BoxManifest>> {
    let Some((value, _)) = read_manifest_value_for_dir(root, item_dir)? else {
        return Ok(None);
    };
    let manifest: BoxManifest =
        serde_json::from_value(value).map_err(|_| error("memory_box_manifest_invalid"))?;
    let issues = validate_manifest(&manifest, expected_id);
    if !issues.is_empty() {
        return Err(CognitionError::new(
            "memory_box_manifest_invalid",
            issues.join("; "),
        ));
    }
    Ok(Some(manifest))
}

pub(super) fn read_manifest_value_for_dir(
    root: &Path,
    item_dir: &Path,
) -> CognitionResult<Option<(Value, PathBuf)>> {
    let Some(items_root) = paths::canonical_items_root(root)? else {
        return Ok(None);
    };
    let item_root = paths::canonical_item_root(&items_root, item_dir)?;
    let path = item_dir.join("manifest.json");
    let Some(file) = paths::open_owned_manifest(&path, &item_root)? else {
        return Ok(None);
    };
    let value = serde_json::from_reader(BufReader::new(file))
        .map_err(|_| error("memory_box_manifest_invalid"))?;
    Ok(Some((value, path)))
}

pub(super) fn manifest_exists(root: &Path, id: &str) -> CognitionResult<bool> {
    if !paths::safe_item_id(id) {
        return Err(error("memory_box_manifest_id_invalid"));
    }
    let item_dir = root.join("items").join(id);
    let Some(items_root) = paths::canonical_items_root(root)? else {
        return Ok(false);
    };
    let item_root = match paths::canonical_item_root(&items_root, &item_dir) {
        Ok(path) => path,
        Err(error) if error.code == "memory_box_manifest_missing" => return Ok(false),
        Err(error) => return Err(error),
    };
    let path = item_dir.join("manifest.json");
    let Some(file) = paths::open_owned_manifest(&path, &item_root)? else {
        return Ok(false);
    };
    serde_json::from_reader::<_, Value>(BufReader::new(file))
        .map(|_| true)
        .map_err(|_| error("memory_box_manifest_invalid"))
}

pub(super) fn validate_manifest(manifest: &BoxManifest, expected_id: &str) -> Vec<String> {
    let mut issues = Vec::new();
    if manifest.schema != ITEM_SCHEMA {
        issues.push("schema must be butler.cognition.box.item.v1".into());
    }
    if !manifest.box_item_id.starts_with("box_") {
        issues.push("box_item_id must start with box_".into());
    }
    if manifest.box_item_id != expected_id {
        issues.push("box_item_id must match item directory".into());
    }
    if manifest
        .files
        .iter()
        .any(|file| !matches!(file.ownership.as_str(), "box-owned" | "external-user-owned"))
    {
        issues.push("invalid file ownership".into());
    }
    issues
}

pub(super) fn write_manifest_value(path: &Path, manifest: &Value) -> CognitionResult<()> {
    let mut bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|_| error("memory_box_manifest_write_failed"))?;
    bytes.push(b'\n');
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| error("memory_box_manifest_write_failed"))?;
    let temporary = parent.join(format!("{file_name}.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| error("memory_box_manifest_write_failed"))?;
        file.write_all(&bytes)
            .map_err(|_| error("memory_box_manifest_write_failed"))?;
        file.sync_all()
            .map_err(|_| error("memory_box_manifest_write_failed"))?;
        fs::rename(&temporary, path).map_err(|_| error("memory_box_manifest_write_failed"))?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("memory_box_manifest_write_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
