use rusqlite::Connection;

use crate::btcc::AuthorityError;
use crate::btcc::authority::contracts::{
    AuthorityAdmissionInput, AuthorityRecord, AuthorityRepository, AuthorityResult, DecisionWrite,
    OutcomeWrite,
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
    fn has_permission(&mut self, grant_ref: &str) -> AuthorityResult<bool> {
        query::has_permission(self.db, grant_ref)
    }
    fn revoke_permissions(
        &mut self,
        grants: &[(String, String)],
        now: &str,
    ) -> AuthorityResult<()> {
        write::revoke_permissions(self.db, grants, now)
    }
    fn revoke_permission(
        &mut self,
        owner: &str,
        grant_ref: &str,
        now: &str,
    ) -> AuthorityResult<()> {
        write::revoke_permission(self.db, owner, grant_ref, now)
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
    fn decide(&mut self, write: DecisionWrite) -> AuthorityResult<Option<AuthorityRecord>> {
        // A decision is the recovery source for its reconstructible resume
        // queue entry. FULL syncs this commit (including the earlier message
        // and continuation) before either the HTTP reply or execution wake.
        // Keep this on the serialized writer and restore its normal policy on
        // every error path; no checkpoint or unrelated file sync is needed.
        let synchronous: i64 = self
            .db
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(query::sql)?;
        self.db
            .pragma_update(None, "synchronous", synchronous.max(2))
            .map_err(query::sql)?;
        let result =
            butler_platform::sqlite::with_fullfsync(self.db, |db| write::decide(db, write))
                .map_err(query::sql);
        let restored = self
            .db
            .pragma_update(None, "synchronous", synchronous)
            .map_err(query::sql);
        restored?;
        result?
    }
    fn settle_question_followup(&mut self, request_ref: &str) -> AuthorityResult<()> {
        write::settle_question_followup(self.db, request_ref)
    }
    fn settle_deferred_question(
        &mut self,
        owner: &str,
        request_ref: &str,
        receipt: &str,
        now: &str,
    ) -> AuthorityResult<()> {
        self.db
            .execute(
                super::pending_asks::DISMISS,
                rusqlite::params![request_ref, owner, receipt, now],
            )
            .map_err(query::sql)?;
        Ok(())
    }
    fn record_question_followup(
        &mut self,
        request_ref: &str,
        response: &str,
        now: &str,
    ) -> AuthorityResult<()> {
        write::record_question_followup(self.db, request_ref, response, now)
    }
    fn record_outcome(&mut self, write: OutcomeWrite) -> AuthorityResult<()> {
        write::record_outcome(self.db, &write)
    }
    fn close_self(&mut self, session: &str, reason: &str, now: &str) -> AuthorityResult<usize> {
        close::close_pending_self_session_requests(self.db, session, reason, now)
            .map_err(AuthorityError::from)
    }
}
