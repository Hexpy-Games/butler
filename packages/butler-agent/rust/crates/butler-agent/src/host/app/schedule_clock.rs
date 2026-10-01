//! Deterministic App clock for stub E2E boundary scenarios, absent in releases.
use crate::host::SystemIdentity;
use butler_gateway::gateway::AppIdentityClock;
use std::sync::Arc;

pub(in crate::host) fn clock() -> Arc<dyn AppIdentityClock> {
    #[cfg(debug_assertions)]
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && let Ok(now) = std::env::var("BUTLER_E2E_APP_NOW")
        && chrono::DateTime::parse_from_rfc3339(&now).is_ok()
    {
        return Arc::new(FixedClock(now));
    }
    Arc::new(SystemIdentity)
}

#[cfg(debug_assertions)]
struct FixedClock(String);
#[cfg(debug_assertions)]
impl AppIdentityClock for FixedClock {
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_iso(&self) -> String {
        self.0.clone()
    }
    fn iso_after_millis(&self, millis: u64) -> String {
        chrono::DateTime::parse_from_rfc3339(&self.0)
            .ok()
            .and_then(|now| {
                now.checked_add_signed(chrono::Duration::milliseconds(i64::try_from(millis).ok()?))
            })
            .map(|now| {
                now.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_else(|| self.0.clone())
    }
}
