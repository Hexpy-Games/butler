//! Filesystem state transitions for one source-format inbound queue.

mod claim;
mod identity;
mod io;
mod settlement;

pub(super) use claim::claim;
pub(super) use claim::recover_stale;
pub(super) use identity::{enqueue_idempotent, find_idempotent};
pub(super) use settlement::{park, recover_runtime_interruptions, settle};

use std::path::{Path, PathBuf};

fn record_path(root: &Path, state: &str, queue_id: &str) -> PathBuf {
    root.join(state).join(format!("{queue_id}.json"))
}

const STATES: [&str; 4] = ["pending", "processing", "processed", "failed"];
