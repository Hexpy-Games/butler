//! Wall-clock implementations of the workspace and conversation clock ports
//! for tests of those domains (the host composes its own `SystemIdentity`).

use std::time::SystemTime;

use butler_core::js_date as date;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::conversation::ConversationIdentityClock;
use crate::workspace::{WorkspaceClock, WorkspaceCode, WorkspaceError, WorkspaceResult};

pub(crate) struct SystemClock;

impl WorkspaceClock for SystemClock {
    fn now_epoch_millis(&self) -> i64 {
        let now: DateTime<Utc> = SystemTime::now().into();
        now.timestamp_millis()
    }

    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        date::parse_iso_millis(value)
    }

    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String> {
        date::format_iso_millis(value).ok_or_else(|| {
            WorkspaceError::new(
                WorkspaceCode::WorkspaceInvalidTime,
                "Invalid session revision timestamp",
            )
        })
    }
}

impl ConversationIdentityClock for SystemClock {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", Uuid::new_v4())
    }

    fn now_iso(&self) -> String {
        date::iso_from_system_time(SystemTime::now())
    }
}
