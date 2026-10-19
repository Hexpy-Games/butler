//! Explicit fault-build ports. This module is absent from shipped builds.
//!
//! The App transcript delivery is in-process, so a fake HTTP target cannot
//! fail it. Likewise, the system clock and pinned asset identities cannot be
//! replaced by provider responses. Keep their fixture wiring at this boundary.
mod clock;
mod embedding;
pub(in crate::host) mod memory;
pub(in crate::host) mod service;
pub(in crate::host) mod tools;
pub(in crate::host) use clock::clock;
pub(in crate::host) use embedding::{embedding_manifest, embedding_sources, local_asset_sources};

use crate::host::service::ingress::IngressError;
use parking_lot::Mutex;
use std::sync::OnceLock;

/// Fail the requested number of interruption reports, then use real delivery.
/// State is process-local; no data-directory marker is read or removed.
pub(in crate::host) fn interruption_report() -> Result<(), IngressError> {
    static REMAINING: OnceLock<Mutex<usize>> = OnceLock::new();
    let remaining = REMAINING.get_or_init(|| {
        Mutex::new(
            std::env::var("BUTLER_E2E_INTERRUPT_REPORT_FAILURES")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        )
    });
    let mut remaining = remaining.lock();
    if *remaining > 0 {
        *remaining -= 1;
        Err(IngressError::new(
            "inbound_delivery_interrupted",
            "Injected transient delivery failure",
        ))
    } else {
        Ok(())
    }
}
