//! Stub faults at the exact response/final/wait boundaries.
use crate::btcc::{BtccError, GuidedInvocation};

pub(super) async fn hold(invocation: GuidedInvocation<'_>, kind: &str) -> Result<(), BtccError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_INSTRUCTION_BOUNDARY").as_deref() != Ok(kind)
    {
        return Ok(());
    }
    if std::env::var("BUTLER_E2E_INSTRUCTION_MESSAGE")
        .is_ok_and(|message| message != invocation.turn.original_message)
    {
        return Ok(());
    }
    let data = std::env::var_os("BUTLER_DATA").ok_or_else(|| failure("Missing isolated data"))?;
    let data = std::path::PathBuf::from(data);
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(data.join("e2e-instruction-held"))
        .await
    {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(failure(&error.to_string())),
    }
    loop {
        match tokio::fs::metadata(data.join("e2e-instruction-release")).await {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(failure(&error.to_string())),
        }
        tokio::select! {
            () = invocation.cancellation.cancelled() => return Ok(()),
            () = tokio::time::sleep(std::time::Duration::from_millis(10)) => {},
        }
    }
}

fn failure(message: &str) -> BtccError {
    BtccError::relayed("instruction_stub_boundary_failed", message)
}
