//! Filesystem state transitions for one source-format inbound queue.

mod claim;
mod deferred;
pub(super) use deferred::next_delay;
mod enqueue;
mod identity;
mod io;
mod settlement;

pub(super) use claim::{recover_stale, select as select_claims, take as take_claims};
pub(super) use enqueue::{Prepared, commit as commit_enqueue, prepare as prepare_enqueue};
pub(super) use identity::find_idempotent;
pub(super) use settlement::{
    Settlement, defer, park, publish as publish_settlement, recover_runtime_interruptions,
    release as release_claim, settle,
};

use std::path::{Path, PathBuf};

fn record_path(root: &Path, state: &str, queue_id: &str) -> PathBuf {
    root.join(state).join(format!("{queue_id}.json"))
}

const STATES: [&str; 4] = ["pending", "processing", "processed", "failed"];
