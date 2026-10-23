//! E2E fixture ordering for a record write that overlaps forced shutdown,
//! and stop points inside DATA ownership transitions.
use std::sync::{Condvar, Mutex, PoisonError};

use super::InstanceRecord;

#[derive(Default)]
struct Order {
    lock_wait: bool,
    cancelled: bool,
    finished: bool,
}

static ORDER: (Mutex<Order>, Condvar) = (
    Mutex::new(Order {
        lock_wait: false,
        cancelled: false,
        finished: false,
    }),
    Condvar::new(),
);

fn mode() -> Option<String> {
    std::env::var("BUTLER_E2E_RECORD_WRITE_DEADLINE").ok()
}

pub(super) fn hold_write(record: &InstanceRecord) {
    if mode().is_none()
        || record.state != "ready"
        || record.app_enabled
        || super::super::shutdown_trace::stop_elapsed().is_none()
    {
        return;
    }
    super::super::shutdown_trace::event("record_write_hold:begin");
    let (lock, wake) = &ORDER;
    let mut waiting = lock.lock().unwrap_or_else(PoisonError::into_inner);
    while !waiting.lock_wait {
        waiting = wake.wait(waiting).unwrap_or_else(PoisonError::into_inner);
    }
    super::super::shutdown_trace::event("record_write_hold:end");
}

pub(super) fn lock_wait() {
    if mode().is_some() {
        let mut order = ORDER.0.lock().unwrap_or_else(PoisonError::into_inner);
        if !order.lock_wait {
            super::super::shutdown_trace::event("record_lock_wait:begin");
            order.lock_wait = true;
            ORDER.1.notify_all();
        }
    }
}

pub(super) fn hold_rename() {
    if mode().as_deref() == Some("stalled-rename")
        && super::super::shutdown_trace::stop_elapsed().is_some()
    {
        super::super::shutdown_trace::event("record_rename_hold:begin");
        let (lock, wake) = &ORDER;
        let mut waiting = lock.lock().unwrap_or_else(PoisonError::into_inner);
        while !waiting.cancelled {
            waiting = wake.wait(waiting).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

pub(super) fn cancel_rename() {
    if mode().as_deref() != Some("stalled-rename") {
        return;
    }
    let (lock, wake) = &ORDER;
    let mut order = lock.lock().unwrap_or_else(PoisonError::into_inner);
    order.cancelled = true;
    wake.notify_all();
    // Prove the delayed write resumes and fails before checking final removal.
    while !order.finished {
        order = wake.wait(order).unwrap_or_else(PoisonError::into_inner);
    }
}

pub(super) fn write_finished() {
    if mode().as_deref() == Some("stalled-rename")
        && super::super::shutdown_trace::stop_elapsed().is_some()
    {
        let mut order = ORDER.0.lock().unwrap_or_else(PoisonError::into_inner);
        order.finished = true;
        ORDER.1.notify_all();
    }
}

/// Stops at `point` (`startup`: DATA taken, record not yet written;
/// `release` and `deadline`: record removed, DATA not yet unlocked) while the
/// record lock is held, until the test creates the release file.
pub(super) fn hold(point: &str) {
    if std::env::var("BUTLER_E2E_RECORD_HOLD").as_deref() != Ok(point) {
        return;
    }
    let Some(release) = std::env::var_os("BUTLER_E2E_RECORD_HOLD_RELEASE") else {
        return;
    };
    super::super::shutdown_trace::event(&format!("record_hold:{point}"));
    while !std::path::Path::new(&release).exists() {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    super::super::shutdown_trace::event(&format!("record_hold:{point}:released"));
}
