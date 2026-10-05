//! Opt-in E2E faults. This entire module is absent from release builds.

use std::sync::atomic::{AtomicBool, Ordering};

use super::{AppApplication, GatewayApplicationError, app_error, storage::AppStorageError};

static FIRED: AtomicBool = AtomicBool::new(false);

impl AppApplication {
    pub(super) async fn inject_dispatch_fault(&self) -> Result<(), GatewayApplicationError> {
        let Ok(fault) = std::env::var("BUTLER_E2E_DISPATCH_FAULT") else {
            return Ok(());
        };
        if FIRED.swap(true, Ordering::Relaxed) {
            return Ok(());
        }
        match fault.as_str() {
            "lane" => self.storage.exclusive(panic_lane).await.map_err(app_error),
            "owner" => self.automation_runs.inject_panic().await,
            "closing" => self.storage.close().await.map_err(app_error),
            _ => Ok(()),
        }
    }
}

#[expect(clippy::panic, reason = "opt-in debug-only E2E fault injection")]
fn panic_lane(db: &mut rusqlite::Connection) -> Result<(), AppStorageError> {
    // Exercise recovery of raw transactions as well as RAII transactions.
    db.execute_batch("BEGIN IMMEDIATE; UPDATE app_automations SET title='uncommitted panic';")
        .map_err(AppStorageError::sqlite)?;
    panic!("e2e-app-lane-panic-sentinel");
}

#[expect(clippy::panic, reason = "opt-in debug-only E2E fault injection")]
pub(super) fn panic_owner() -> ! {
    panic!("e2e-automation-owner-panic-sentinel");
}
