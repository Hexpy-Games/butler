use std::{
    path::Path,
    sync::{Arc, PoisonError},
    time::Duration,
};

use butler_platform::{data_paths, sqlite};
use rusqlite::OpenFlags;

use super::{Error, Inner, Phase, Result};

const RETRY: Duration = Duration::from_secs(600);
const DAY: Duration = Duration::from_hours(24);

pub(super) async fn run(inner: Arc<Inner>) {
    let mut resumed = false;
    loop {
        let view = inner.local_view();
        if !view.enabled {
            return;
        }
        let delay = if resumed {
            DAY
        } else {
            view.last_success_at
                .as_deref()
                .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
                .map_or(RETRY, |last| {
                    (last + chrono::TimeDelta::days(1))
                        .signed_duration_since(chrono::Utc::now())
                        .to_std()
                        .unwrap_or_default()
                })
        };
        // "지금 백업" runs at once; only the daily run waits for a running turn.
        let mut manual = tokio::select! {
            () = tokio::time::sleep(delay) => false,
            () = inner.now.notified() => true,
        };
        loop {
            let operation = inner.operations.lock().await;
            let pending = inner
                .pending_key
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_some();
            if !inner.local_view().enabled {
                return;
            }
            if pending || matches!(inner.phase(), Phase::RestoreReady | Phase::Restoring { .. }) {
                break;
            }
            let busy = if manual {
                Ok(false)
            } else {
                inner.blocking(|root| turn_running(&root)).await
            };
            match busy {
                Ok(false) => {
                    inner.set_phase(Phase::Running { done: 0, total: 0 });
                    drop(operation);
                    inner.set_phase(match inner.back_up().await {
                        Ok(()) => Phase::Idle,
                        Err(failure) => Phase::Failed(super::error_code(&failure)),
                    });
                    break;
                }
                Ok(true) => {
                    drop(operation);
                    manual = tokio::select! {
                        () = tokio::time::sleep(RETRY) => false,
                        () = inner.now.notified() => true,
                    };
                }
                Err(failure) => {
                    inner.set_phase(Phase::Failed(super::error_code(&failure)));
                    break;
                }
            }
        }
        resumed = true;
    }
}

fn turn_running(root: &Path) -> Result<bool> {
    let path = root.join(data_paths::APP_DB);
    if !path.try_exists().map_err(Error::internal_from)? {
        return Ok(false);
    }
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|db| db.query_row(
            "SELECT EXISTS(SELECT 1 FROM turns WHERE state IN ('accepted','thinking','streaming','waiting_for_form','waiting_for_tool','cancelling','retrying'))",
            [],
            |row| row.get(0),
        )).map_err(Error::internal_from)
}
