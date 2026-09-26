use rusqlite::Connection;

use crate::btcc::authority::contracts::{
    AuthorityAdmissionInput, AuthorityRecord, AuthorityRepository, AuthorityResult,
    AuthorityResumeSource, ConversationPermission, DecisionWrite, OutcomeWrite,
};

use super::{close, query, write};

pub(crate) struct SqliteAuthorityRepository<'a> {
    db: &'a mut Connection,
}
impl<'a> SqliteAuthorityRepository<'a> {
    pub(crate) fn new(db: &'a mut Connection) -> Self {
        Self { db }
    }
}
impl AuthorityRepository for SqliteAuthorityRepository<'_> {
    fn retains_approval_claim(&mut self, turn_id: &str) -> AuthorityResult<bool> {
        query::retains_approval_claim(self.db, turn_id)
    }
    fn has_permission(&mut self, grant_ref: &str) -> AuthorityResult<bool> {
        query::has_permission(self.db, grant_ref)
    }
    fn list_permissions(&mut self, owner: &str) -> AuthorityResult<Vec<ConversationPermission>> {
        query::list_permissions(self.db, owner)
    }
    fn revoke_permission(
        &mut self,
        owner: &str,
        grant_ref: &str,
        now: &str,
    ) -> AuthorityResult<()> {
        write::revoke_permission(self.db, owner, grant_ref, now)
    }
    fn resume_source(
        &mut self,
        request_ref: &str,
    ) -> AuthorityResult<Option<AuthorityResumeSource>> {
        query::resume_source(self.db, request_ref)
    }
    fn waiting_source_sessions(&mut self) -> AuthorityResult<Vec<String>> {
        query::waiting_source_sessions(self.db)
    }
    fn find_identity(&mut self, sha: &str) -> AuthorityResult<Option<AuthorityRecord>> {
        query::find(self.db, "identity_sha256", sha)
    }
    fn find_slot(
        &mut self,
        input: &AuthorityAdmissionInput,
        generation: i64,
    ) -> AuthorityResult<Option<AuthorityRecord>> {
        query::find_slot(self.db, input, generation)
    }
    fn insert(&mut self, record: &AuthorityRecord) -> AuthorityResult<()> {
        write::insert(self.db, record)
    }
    fn find_ref(&mut self, request_ref: &str) -> AuthorityResult<Option<AuthorityRecord>> {
        query::find(self.db, "request_ref", request_ref)
    }
    fn list_pending(&mut self, owner: &str) -> AuthorityResult<Vec<AuthorityRecord>> {
        query::list_pending(self.db, owner)
    }
    fn list_decided(&mut self) -> AuthorityResult<Vec<AuthorityRecord>> {
        query::list_decided(self.db)
    }
    fn source_work_eligible(&mut self, session: &str, work: &str) -> AuthorityResult<bool> {
        query::source_work_eligible(self.db, session, work)
    }
    fn decide(&mut self, write: DecisionWrite) -> AuthorityResult<Option<AuthorityRecord>> {
        write::decide(self.db, write)
    }
    fn record_outcome(&mut self, write: OutcomeWrite) -> AuthorityResult<()> {
        write::record_outcome(self.db, write)
    }
    fn close_self(&mut self, session: &str, reason: &str, now: &str) -> AuthorityResult<usize> {
        close::close_pending_self_session_requests(self.db, session, reason, now)
            .map_err(super::sql_error)
    }
}
