//! Durable execution and result delivery journal on the existing BTCC SQLite lane.
//! Each command completes synchronously on that lane; no record cache is retained.

mod contracts;
mod delivery;
mod read;
mod write;

#[cfg(test)]
mod exact_tests;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use super::{BtccStorage, StorageResult};
pub(crate) use contracts::{
    ToolJournalCloseoutRow, ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRecord,
    ToolJournalSignature, ToolJournalStart,
};

pub(crate) struct ToolJournalRepository {
    storage: BtccStorage,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
}

impl ToolJournalRepository {
    pub(crate) fn new(storage: BtccStorage, clock: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self { storage, clock }
    }

    pub(crate) async fn start(&self, input: ToolJournalStart) -> StorageResult<()> {
        let clock = self.clock.clone();
        self.storage
            .execute(move |db| write::start(db, input, &*clock))
            .await
    }

    pub(crate) async fn finish(&self, input: ToolJournalFinish) -> StorageResult<()> {
        let clock = self.clock.clone();
        self.storage
            .execute(move |db| write::finish(db, input, &*clock))
            .await
    }

    pub(crate) async fn find_for_turn(
        &self,
        turn_id: String,
        call_id: String,
    ) -> StorageResult<Option<ToolJournalRecord>> {
        self.storage
            .execute(move |db| read::find(db, &turn_id, &call_id))
            .await
    }

    pub(crate) async fn restart_requests(
        &self,
        turn_id: String,
    ) -> StorageResult<Vec<ToolJournalRecord>> {
        self.storage
            .execute(move |db| read::restart_requests(db, &turn_id))
            .await
    }

    /// Prompt continuity needs only the newest source-visible calls. Result
    /// bodies are hydrated for this one projection and released before model I/O.
    pub(crate) async fn recent_for_prompt(
        &self,
        turn_id: String,
    ) -> StorageResult<Vec<ToolJournalRecord>> {
        self.storage
            .execute(move |db| read::recent_for_prompt(db, &turn_id))
            .await
    }

    pub(crate) async fn closeout_page(
        &self,
        turn_id: String,
        after_rowid: i64,
        limit: usize,
    ) -> StorageResult<Vec<ToolJournalCloseoutRow>> {
        self.storage
            .execute(move |db| read::closeout_page(db, &turn_id, after_rowid, limit))
            .await
    }

    pub(crate) async fn list_signatures(
        &self,
        turn_id: String,
    ) -> StorageResult<Vec<ToolJournalSignature>> {
        self.storage
            .execute(move |db| read::list_signatures(db, &turn_id))
            .await
    }

    /// Work backfill consumes identities, never prior result bodies or arguments.
    pub(crate) async fn completed_call_identities(
        &self,
        turn_id: String,
    ) -> StorageResult<Vec<(String, String)>> {
        self.storage
            .execute(move |db| read::completed_call_identities(db, &turn_id))
            .await
    }

    pub(crate) async fn admit_delivery(
        &self,
        turn_id: String,
        call_id: String,
    ) -> StorageResult<()> {
        self.storage
            .execute(move |db| delivery::admit(db, &turn_id, &call_id))
            .await
    }

    pub(crate) async fn begin_delivery(
        &self,
        turn_id: String,
        call_id: String,
        round_id: String,
    ) -> StorageResult<()> {
        self.storage
            .execute(move |db| delivery::begin(db, &turn_id, &call_id, &round_id))
            .await
    }

    pub(crate) async fn release_deliveries(
        &self,
        turn_id: String,
        round_id: String,
    ) -> StorageResult<()> {
        self.storage
            .execute(move |db| delivery::release(db, &turn_id, &round_id))
            .await
    }

    pub(crate) async fn acknowledge_deliveries(
        &self,
        turn_id: String,
        round_id: String,
        response_sha256: String,
    ) -> StorageResult<()> {
        self.storage
            .execute(move |db| delivery::acknowledge(db, &turn_id, &round_id, &response_sha256))
            .await
    }

    pub(crate) async fn promote_acknowledged(
        &self,
        turn_id: String,
        call_id: String,
    ) -> StorageResult<()> {
        self.storage
            .execute(move |db| delivery::promote(db, &turn_id, &call_id))
            .await
    }
}
