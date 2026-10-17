//! Atomic source-format record writes and bounded record reads.
//!
//! A write is staged (created, written and, when durable, synced) without the
//! queue lane, committed by one rename under it, and its directory is synced
//! after the lane is released but before the caller is answered.

use std::{fs, io::Write, path::Path};

use butler_platform::secure_fs;

use super::super::{InboundQueueError, QueueResult, QueuedInboundEvent};
use crate::gateway::InboundQueueCode;

/// Stub-only process interruption points around one kind of record write.
#[derive(Clone, Copy)]
pub(in crate::gateway::inbound_queue) struct Phase {
    staged: &'static str,
    renamed: &'static str,
}

pub(in crate::gateway::inbound_queue) const ENQUEUE: Phase = Phase {
    staged: "inbound_enqueue_staged",
    renamed: "inbound_enqueue_renamed",
};
pub(in crate::gateway::inbound_queue) const CLAIM: Phase = Phase {
    staged: "inbound_claim_staged",
    renamed: "inbound_claim_renamed",
};
pub(in crate::gateway::inbound_queue) const SETTLE: Phase = Phase {
    staged: "inbound_settle_staged",
    renamed: "inbound_settle_renamed",
};
const RECOVER: Phase = Phase {
    staged: "inbound_recover_staged",
    renamed: "inbound_recover_renamed",
};

/// A complete record file next to its destination, removed unless committed.
pub(in crate::gateway::inbound_queue) struct Staged {
    file: secure_fs::StagedFile,
    phase: Phase,
}

/// A visible record whose directory entry is synced by [`Committed::sync`].
#[must_use = "a durable record is complete only after sync"]
pub(in crate::gateway::inbound_queue) struct Committed(secure_fs::Committed);

pub(super) fn read(path: &Path) -> QueueResult<Option<QueuedInboundEvent>> {
    Ok(read_raw(path)?.and_then(|bytes| parse(&bytes)))
}

/// The exact bytes of a record file, so a later read can tell it is unchanged.
pub(super) fn read_raw(path: &Path) -> QueueResult<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

pub(super) fn parse(bytes: &[u8]) -> Option<QueuedInboundEvent> {
    let record: QueuedInboundEvent = serde_json::from_slice(bytes).ok()?;
    (record.version == 1 && !record.queue_id.is_empty()).then_some(record)
}

/// Stages, commits and syncs one record while the caller holds the lane;
/// startup recovery and rare fallbacks only.
pub(super) fn atomic_write(path: &Path, record: &QueuedInboundEvent) -> QueueResult<()> {
    stage(path, record, true, RECOVER)?.commit()?.sync()
}

pub(super) fn stage(
    path: &Path,
    record: &QueuedInboundEvent,
    durable: bool,
    phase: Phase,
) -> QueueResult<Staged> {
    let parent = path.parent().ok_or_else(|| {
        InboundQueueError::new(
            InboundQueueCode::InboundQueuePathInvalid,
            "Invalid queue path",
        )
    })?;
    ensure_dir(parent)?;
    let mut bytes = serde_json::to_vec_pretty(record).map_err(|error| {
        InboundQueueError::new(
            InboundQueueCode::InboundQueueEncodeFailed,
            error.to_string(),
        )
        .with_source(error)
    })?;
    bytes.push(b'\n');
    let write = |file: &mut fs::File| file.write_all(&bytes).map_err(io_error);
    let file = secure_fs::stage_private(path, write, io_error, durable)?;
    secure_fs::abort_point(phase.staged);
    Ok(Staged { file, phase })
}

impl Staged {
    /// Renames the record into place; the caller holds the lane.
    pub(super) fn commit(self) -> QueueResult<Committed> {
        let committed = self.file.commit().map_err(io_error)?;
        secure_fs::abort_point(self.phase.renamed);
        Ok(Committed(committed))
    }
}

impl Committed {
    pub(in crate::gateway::inbound_queue) fn sync(self) -> QueueResult<()> {
        self.0.sync().map_err(io_error)
    }
}

pub(super) fn file_names(path: &Path) -> QueueResult<Vec<String>> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error(error)),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

pub(super) fn ensure_dir(path: &Path) -> QueueResult<()> {
    secure_fs::create_private_dir_all(path).map_err(io_error)
}

pub(super) fn io_error(error: std::io::Error) -> InboundQueueError {
    InboundQueueError::new(InboundQueueCode::InboundQueueIoFailed, error.to_string())
        .with_source(error)
}
