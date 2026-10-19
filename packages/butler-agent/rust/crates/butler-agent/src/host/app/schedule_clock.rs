//! The App identity clock; shipped builds always use system time.
use crate::host::SystemIdentity;
use butler_gateway::gateway::AppIdentityClock;
use std::sync::Arc;

pub(in crate::host) fn clock() -> Arc<dyn AppIdentityClock> {
    #[cfg(feature = "e2e-fixtures")]
    if let Some(clock) = crate::host::faults::clock() {
        return clock;
    }
    Arc::new(SystemIdentity)
}
