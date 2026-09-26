//! Compact index loading, source scan, and source-shaped stale refresh.

mod freshness;
mod records;
mod validation;

use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::{Value, json};

use crate::locale::LocaleCollation;
use crate::project_ledger::committed;

use super::{CliFailure, CommandContext, display_path, io_failure, now_iso};

const INDEX_PATH: &str = "index/project.json";

pub(super) fn status(
    context: &CommandContext,
    collation: &LocaleCollation,
) -> Result<Value, CliFailure> {
    let index = load(&context.root, collation)?;
    Ok(json!({
        "project":index.get("project"),
        "index":index.get("index"),
        "counts":index.get("counts"),
        "issueCount":index.get("issues").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "staleViews":crate::project_ledger::commands::query::select(&index,"stale-view",&json!({}),collation)?,
        "nextActions":crate::project_ledger::commands::query::select(&index,"next-actions",&json!({}),collation)?
            .as_array().map(|rows| rows.iter().take(5).cloned().collect::<Vec<_>>()).unwrap_or_default(),
    }))
}

pub(super) fn write(
    context: &CommandContext,
    _collation: &LocaleCollation,
) -> Result<Value, CliFailure> {
    super::with_mutation_claim(&context.root, || write_unlocked(&context.root))
}

pub(super) fn refresh_after_mutation(root: &Path, record: Value) -> Value {
    let mut result = record;
    let derived = match write_unlocked(root) {
        Ok(index) => json!({
            "index_refresh":{
                "ok":true,
                "records":index.pointer("/counts/records"),
                "issues":index.get("issues").and_then(Value::as_array).map(Vec::len),
                "path":index.pointer("/index/path"),
                "generatedAt":index.pointer("/index/generatedAt"),
            },
            "warnings":[],
        }),
        Err(_) => json!({
            "index_refresh":{"ok":false,"error":"index_refresh_failed"},
            "warnings":[{
                "code":"derived_index_refresh_failed",
                "message":"Source mutation succeeded but Project Ledger compact index refresh failed. Run `project-ledger index --project PATH` or Butler native `project_ledger_index` before relying on derived views.",
                "next":[
                    {"command":"project-ledger index --project PATH","reason":"Rebuild the compact Project Ledger index from source records."},
                    {"tool":"project_ledger_index","args":{"project_path":"PATH"},"reason":"Use Butler native Project Ledger index refresh when operating through native tools."}
                ]
            }],
        }),
    };
    result["derived"] = derived;
    result
}

pub(super) fn load(root: &Path, collation: &LocaleCollation) -> Result<Value, CliFailure> {
    if !committed::publication_version(root)
        .map_err(|_| io_failure())?
        .is_empty()
    {
        return build(root);
    }
    let observed = read_index(root);
    if let Ok(Some(index)) = observed
        && index.pointer("/index/stale").and_then(Value::as_bool) == Some(false)
    {
        return Ok(index);
    }
    let context = CommandContext {
        root: root.to_path_buf(),
    };
    write(&context, collation).or_else(|_| build(root))
}

/// The caller already holds the source mutation claim (render --write).
pub(super) fn load_locked(root: &Path) -> Result<Value, CliFailure> {
    if !committed::publication_version(root)
        .map_err(|_| io_failure())?
        .is_empty()
    {
        return build(root);
    }
    if let Ok(Some(index)) = read_index(root)
        && index.pointer("/index/stale").and_then(Value::as_bool) == Some(false)
    {
        return Ok(index);
    }
    write_unlocked(root).or_else(|_| build(root))
}

pub(super) fn read_index(root: &Path) -> Result<Option<Value>, CliFailure> {
    if !committed::publication_version(root)
        .map_err(|_| io_failure())?
        .is_empty()
    {
        return build(root).map(Some);
    }
    let path = root.join(INDEX_PATH);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|_| io_failure())?;
    let mut index: Value = serde_json::from_str(&raw)
        .map_err(|_| CliFailure::new("invalid_json", "Invalid Project Ledger index JSON"))?;
    let source_mtime = freshness::source_max_mtime(root)?;
    index["views"] = freshness::views(root, source_mtime)?;
    index["index"] = freshness::index(root, source_mtime)?;
    Ok(Some(index))
}

pub(super) fn build(root: &Path) -> Result<Value, CliFailure> {
    let records = records::read(root)?;
    let counts = records::count(&records.projected);
    let projected = records
        .projected
        .into_iter()
        .map(|mut record| {
            if let Some(object) = record.as_object_mut() {
                object.shift_remove("sourceMtimeMs");
            }
            record
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "schema":"project-ledger.index.v1",
        "generatedAt":now_iso()?,
        "project":records.project,
        "counts":counts,
        "records":projected,
        "issues":records.issues,
        "views":freshness::views(root,records.max_mtime_ms)?,
        "index":freshness::index(root,records.max_mtime_ms)?,
        "privacy":{"rawTextIncluded":false,"secretsIncluded":false},
    }))
}

fn write_unlocked(root: &Path) -> Result<Value, CliFailure> {
    let mut index = build(root)?;
    let path = root.join(INDEX_PATH);
    fs::create_dir_all(path.parent().ok_or_else(io_failure)?).map_err(|_| io_failure())?;
    let generated_at = now_iso()?;
    index["index"] = json!({
        "available":true,"stale":false,"generatedAt":generated_at,
        "path":display_path(root, Path::new(INDEX_PATH)),
    });
    let mut bytes = serde_json::to_vec_pretty(&index).map_err(|_| io_failure())?;
    bytes.push(b'\n');
    fs::write(&path, bytes).map_err(|_| io_failure())?;
    let event = json!({
        "schema":"project-ledger.event.v1",
        "ts":now_iso()?,
        "type":"index_written",
        "records":index.pointer("/counts/records"),
        "issues":index.get("issues").and_then(Value::as_array).map(Vec::len),
        "source":"project-ledger",
    });
    let mut event = crate::json::stringify(&event)
        .map_err(|_| io_failure())?
        .into_bytes();
    event.push(b'\n');
    fs::OpenOptions::new()
        .append(true)
        .open(root.join("ledger.jsonl"))
        .and_then(|mut file| file.write_all(&event))
        .map_err(|_| io_failure())?;
    read_index(root)?.ok_or_else(io_failure)
}
