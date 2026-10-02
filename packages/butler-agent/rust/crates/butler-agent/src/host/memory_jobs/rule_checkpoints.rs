//! Stub-only crash checkpoint adapter; absent in ordinary operation.
use butler_memory::cognition::{CognitionCode, CognitionError, RememberedRuleOwner};
use std::{path::Path, sync::Arc};

pub(in crate::host) fn configure(owner: RememberedRuleOwner, data: &Path) -> RememberedRuleOwner {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_RULE_CRASH_POINTS").as_deref() != Ok("1")
    {
        return owner;
    }
    let state = data.join("state");
    owner.with_commit_observer(Arc::new(move |stage, operation| {
        let arm = state.join("rule-crash-arm.json");
        let desired = match std::fs::read(&arm) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).map_err(error)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => return Err(error(source)),
        };
        if desired["stage"] != stage {
            return Ok(());
        }
        std::fs::remove_file(&arm).map_err(error)?;
        std::fs::write(
            state.join("rule-crash-reached.json"),
            serde_json::json!({"stage":stage,"operation_id":operation}).to_string(),
        )
        .map_err(error)?;
        // The harness kills only its own child after observing this durable boundary.
        loop {
            std::thread::park();
        }
    }))
}

fn error(source: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceUnavailable, source.to_string())
        .with_source(source)
}
