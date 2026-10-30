//! Read-only authority queries share one fresh committed WAL snapshot.
use super::query;
use crate::btcc::authority::contracts::{
    AuthorityRecord, AuthorityResult, AuthorityResumeSource, ConversationPermission,
    PermissionSource,
};
use rusqlite::Connection;

pub(crate) struct SqliteAuthorityReader<'a> {
    db: &'a Connection,
}

impl<'a> SqliteAuthorityReader<'a> {
    pub(crate) fn new(db: &'a Connection) -> Self {
        Self { db }
    }
    pub(crate) fn retains_approval_claim(&self, turn_id: &str) -> AuthorityResult<bool> {
        query::retains_approval_claim(self.db, turn_id)
    }
    pub(crate) fn stop_confirmed(&self, turn_id: &str) -> AuthorityResult<bool> {
        query::stop_confirmed(self.db, turn_id)
    }
    pub(crate) fn list_pending(&self, owner: &str) -> AuthorityResult<Vec<AuthorityRecord>> {
        query::list_pending(self.db, owner)
    }
    pub(crate) fn list_decided(&self) -> AuthorityResult<Vec<AuthorityRecord>> {
        query::list_decided(self.db)
    }
    pub(crate) fn resume_source(
        &self,
        request_ref: &str,
    ) -> AuthorityResult<Option<AuthorityResumeSource>> {
        query::resume_source(self.db, request_ref)
    }
    pub(crate) fn waiting_source_sessions(&self) -> AuthorityResult<Vec<String>> {
        query::waiting_source_sessions(self.db)
    }
    pub(crate) fn attention_owners(
        &self,
        owners: &[String],
    ) -> AuthorityResult<Vec<(String, bool)>> {
        query::attention_owners(self.db, owners)
    }
    pub(crate) fn list_permissions(
        &self,
        owner: &str,
    ) -> AuthorityResult<Vec<ConversationPermission>> {
        query::list_permissions(self.db, owner)
    }
    pub(crate) fn list_all_permissions(&self) -> AuthorityResult<Vec<ConversationPermission>> {
        query::list_all_permissions(self.db)
    }
    pub(crate) fn permission_records(&self, owner: &str) -> AuthorityResult<Vec<AuthorityRecord>> {
        query::permission_records(self.db, owner)
    }
    pub(crate) fn permission_projection_records(
        &self,
        owners: &[String],
        visit: &mut dyn FnMut(PermissionSource<'_>) -> AuthorityResult<()>,
    ) -> AuthorityResult<()> {
        query::permission_projection_records(self.db, owners, visit)
    }
}
