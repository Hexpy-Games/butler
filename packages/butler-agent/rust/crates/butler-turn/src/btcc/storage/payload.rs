//! The memo is accessed only inside serialized storage-lane closures.
use super::{BtccStorage, StorageCode, StorageError, StorageResult, model::memo::ContinuationMemo};
use std::sync::{Arc, Mutex, MutexGuard};

pub(super) type PayloadMemo = Arc<Mutex<ContinuationMemo>>;

impl BtccStorage {
    pub(super) fn payload_memo(&self) -> PayloadMemo {
        Arc::clone(&self.inner.payload)
    }
}
pub(super) fn lock(memo: &PayloadMemo) -> StorageResult<MutexGuard<'_, ContinuationMemo>> {
    memo.lock().map_err(|_| {
        StorageError::new(
            StorageCode::ModelAcceptanceDeltaInvalid,
            "acceptance memo unavailable",
        )
    })
}
