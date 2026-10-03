//! Process-wide wake signal for the memory sync loop. Publishing a
//! completion notice or registering a source signals it, so an idle loop can
//! sleep for a long time and still react at once to in-process work.

use tokio::sync::Notify;

static MEMORY_WORK: Notify = Notify::const_new();

/// Tells the sync loop that new memory work exists. The signal is remembered
/// when the loop is not waiting, so it is never lost between two polls.
pub fn signal_memory_work() {
    crate::coordination::signal_inventory_change();
    MEMORY_WORK.notify_one();
}

/// Completes when [`signal_memory_work`] was called since the last wait.
pub(super) async fn memory_work_signalled() {
    MEMORY_WORK.notified().await;
}
