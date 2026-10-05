//! Idempotent profile reset uses the owner's transaction and existing writer lease.
use super::*;
impl ProfileService {
    /// Resets extracted profile content once per operation, preserving names/consent/settings.
    pub async fn reset_profiling_data(
        &self,
        operation_id: String,
        cancellation: CancellationToken,
    ) -> ProfileResult<ClearProfilingResult> {
        if !uuid::Uuid::parse_str(&operation_id)
            .is_ok_and(|value| value.to_string() == operation_id)
        {
            return Err(ProfileError::new(
                ProfileCode::ProfileDataInvalid,
                "Invalid operation ID",
            ));
        }
        let root = self.data_root.clone();
        let coordinator = self.coordinator.clone();
        let lock = self.lock_path();
        self.run_async(cancellation, move |child| async move {
            let executor = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                crate::coordination::ensure_supported_data_authority(
                    &root,
                    &[&storage::database_path(&root), &lock],
                )
                .map_err(storage::io_error)?;
                hold_reset_acquisition(&root, &operation_id, &child)?;
                let lease = executor
                    .block_on(coordinator.acquire(
                        CognitionWriteAcquire {
                            lock_path: lock,
                            purpose: Some("profile_reset".into()),
                            deadline_at_epoch_ms: None,
                            cancellation: Some(child.clone()),
                        },
                        crate::coordination::CognitionWaitClass::Interactive,
                    ))
                    .map_err(|source| {
                        ProfileError::new(
                            ProfileCode::ProfileStoreUnavailable,
                            "Profile store is unavailable.",
                        )
                        .with_source(source)
                    })?
                    .ok_or_else(|| {
                        ProfileError::new(ProfileCode::MemoryWriteBusy, "Memory writer is busy.")
                    })?;
                complete_leased(lease, || storage::clear(&root, &child, &operation_id))
            })
            .await
            .map_err(|error| {
                ProfileError::new(ProfileCode::ProfileOperationFailed, "Profile reset failed")
                    .with_source(error)
            })?
        })
        .await
    }
}

// Deterministic contention on an accepted reset, restricted to isolated stub runs.
fn hold_reset_acquisition(
    root: &std::path::Path,
    operation: &str,
    token: &CancellationToken,
) -> ProfileResult<()> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return Ok(());
    }
    let state = root.join("state");
    let arm = state.join("profile-reset-acquire-arm");
    match std::fs::read_to_string(&arm) {
        Ok(id) if id == operation => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(storage::io_error(error)),
    }
    std::fs::remove_file(arm).map_err(storage::io_error)?;
    std::fs::write(state.join("profile-reset-acquire-reached"), operation)
        .map_err(storage::io_error)?;
    while !state.join("profile-reset-acquire-release").exists() {
        if token.is_cancelled() {
            return Err(ProfileError::new(
                ProfileCode::ProfileOperationFailed,
                "Profile reset cancelled",
            ));
        }
        std::thread::park_timeout(std::time::Duration::from_millis(10));
    }
    Ok(())
}
