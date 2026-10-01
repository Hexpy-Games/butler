//! Render a whole job in memory and publish only changed bytes, once.
use super::receipt::{
    CacheJobReceipt, CacheWriteReceipt, EntryOutcome, ExcludedEntryReceipt, ReceiptScope,
};
use super::{error, format};
use crate::cognition::graph::{CacheWindow, ClaimedCacheJob};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult, ensure_data_authority};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub(super) struct Publication {
    pub body: String,
    pub audit: String,
    pub receipt: CacheJobReceipt,
    pub outcomes: Vec<EntryOutcome>,
}

pub(super) fn read(path: &Path) -> CognitionResult<String> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(value),
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(source) => Err(io_failed(source)),
    }
}

pub(super) fn render_job(
    existing: &str,
    windows: &[CacheWindow],
    valid: &HashSet<String>,
    job: &ClaimedCacheJob,
    path: &Path,
    as_of: &str,
) -> CognitionResult<Publication> {
    let epoch_ms = chrono::DateTime::parse_from_rfc3339(as_of)
        .map_err(|source| error(CognitionCode::HotCacheEntryInvalid).with_source(source))?
        .timestamp_millis();
    let mut body = existing.to_owned();
    let mut audit = String::new();
    let mut receipts = Vec::new();
    let mut outcomes = Vec::new();
    let candidates = if windows.is_empty() {
        vec![None]
    } else {
        windows.iter().map(Some).collect()
    };
    for window in candidates {
        let rendered = format::render(&body, window.map(|window| &window.entry), valid, epoch_ms)?;
        let receipt = write_receipt(
            &rendered,
            window.map_or("", |window| window.entry_id.as_str()),
            job,
            path,
        );
        if let Some(window) = window {
            outcomes.push(EntryOutcome {
                entry_id: window.entry_id.clone(),
                admitted: receipt.admitted,
                reason: None,
                receipt: receipt.clone(),
            });
            receipts.push(receipt.clone());
        }
        for excluded in &rendered.excluded {
            outcomes.push(EntryOutcome {
                entry_id: excluded.id.clone(),
                admitted: false,
                reason: Some(excluded.reason),
                receipt: receipt.clone(),
            });
        }
        body = rendered.body;
        audit.push_str(&rendered.audit);
    }
    Ok(finish_render(body, audit, receipts, outcomes, job))
}

fn finish_render(
    body: String,
    audit: String,
    mut receipts: Vec<CacheWriteReceipt>,
    mut outcomes: Vec<EntryOutcome>,
    job: &ClaimedCacheJob,
) -> Publication {
    // Later windows can evict earlier candidates under the existing budget.
    let installed = format::physical_entries(&body)
        .into_iter()
        .filter_map(|view| view.entry_id)
        .collect::<HashSet<_>>();
    for receipt in &mut receipts {
        receipt.admitted = installed.contains(&receipt.source_id);
        receipt.bytes = body.len();
    }
    for outcome in &mut outcomes {
        outcome.admitted &= installed.contains(&outcome.entry_id);
        outcome.receipt.admitted = outcome.admitted;
        outcome.receipt.bytes = body.len();
    }
    let receipt = if !receipts.is_empty() {
        CacheJobReceipt::written(receipts)
    } else if job.summary_status != "complete" || job.summary.trim().is_empty() {
        CacheJobReceipt::no_summary(&job.generation, &job.episode_id, &job.revision)
    } else {
        CacheJobReceipt::no_window_summary()
    };
    Publication {
        body,
        audit,
        receipt,
        outcomes,
    }
}

fn write_receipt(
    rendered: &format::RenderedCache,
    entry_id: &str,
    job: &ClaimedCacheJob,
    path: &Path,
) -> CacheWriteReceipt {
    CacheWriteReceipt {
        schema_version: "butler.hot-cache-write-receipt.v1",
        source_id: entry_id.to_owned(),
        scope: if job.project_id.is_some() {
            ReceiptScope::Project
        } else {
            ReceiptScope::Global
        },
        project_id: job.project_id.clone(),
        path: path.display().to_string(),
        replayed: rendered.replayed,
        compacted: rendered.compacted,
        bytes: rendered.body.len(),
        generation_id: job.generation.clone(),
        episode_id: job.episode_id.clone(),
        source_revision: job.revision.clone(),
        excluded_entries: rendered
            .excluded
            .iter()
            .map(|item| ExcludedEntryReceipt {
                entry_id: item.id.clone(),
                reason: item.reason,
            })
            .collect(),
        admitted: rendered.admitted,
    }
}

pub(super) fn publish(
    data_root: &Path,
    path: &Path,
    existing: &str,
    rendered: &Publication,
) -> CognitionResult<()> {
    if rendered.body != existing {
        let parent = path
            .parent()
            .ok_or_else(|| error(CognitionCode::HotCacheIoFailed))?;
        ensure_data_authority(data_root, &[parent])?;
        fs::create_dir_all(parent).map_err(io_failed)?;
        replace_file(data_root, path, parent, &rendered.body)?;
    }
    if !rendered.audit.is_empty() {
        append_audit(data_root, path, &rendered.audit)?;
    }
    Ok(())
}

/// Atomically replaces the cache file and syncs its directory.
fn replace_file(data_root: &Path, path: &Path, parent: &Path, body: &str) -> CognitionResult<()> {
    let temp = parent.join(format!(".cache-{}.tmp", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[path, parent, &temp])?;
    let written: CognitionResult<()> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(io_failed)?;
        file.write_all(body.as_bytes()).map_err(io_failed)?;
        file.sync_all().map_err(io_failed)?;
        fs::rename(&temp, path).map_err(io_failed)?;
        butler_platform::secure_fs::sync_path(parent).map_err(io_failed)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Appends legacy and unparseable blocks removed from the cache to its audit file.
fn append_audit(data_root: &Path, path: &Path, audit: &str) -> CognitionResult<()> {
    let audit_path = path.with_extension("md.audit.md");
    ensure_data_authority(data_root, &[&audit_path])?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path)
        .map_err(io_failed)?;
    file.write_all(audit.as_bytes()).map_err(io_failed)?;
    file.sync_all().map_err(io_failed)
}

fn io_failed(source: std::io::Error) -> CognitionError {
    error(CognitionCode::HotCacheIoFailed).with_source(source)
}
