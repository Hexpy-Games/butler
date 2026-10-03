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
            tokio::task::spawn_blocking(move || {
                crate::coordination::ensure_supported_data_authority(
                    &root,
                    &[&storage::database_path(&root), &lock],
                )
                .map_err(storage::io_error)?;
                with_lease(&coordinator, lock, "profile_reset", || {
                    storage::clear(&root, &child, &operation_id)
                })
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
