use std::sync::Arc;

use serde_json::Value;

use super::contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityDecisionInput,
    AuthorityDecisionResult, AuthorityError, AuthorityExecutionInput,
    AuthorityOperationalCloseResult, AuthorityOutcomeInput, AuthorityRepository, AuthorityResult,
    AuthorityResumeSource, AuthorityStoredExecution, ConversationPermission,
    NativePrincipalAuthority,
};
use super::{admission, decision, execution, identity, projection};
use crate::btcc::storage::{BtccStorage, SqliteAuthorityRepository};
use crate::locale::LocaleCollation;

impl NativePrincipalAuthority {
    pub(crate) async fn retains_approval_claim(&self, turn_id: String) -> AuthorityResult<bool> {
        self.in_lane(move |repo| repo.retains_approval_claim(&turn_id))
            .await
    }
    pub(crate) fn new(
        storage: BtccStorage,
        collation: Arc<LocaleCollation>,
        clock: Arc<dyn Fn() -> String + Send + Sync>,
        uuid: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            storage,
            collation,
            clock,
            uuid,
        }
    }
    async fn in_lane<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut dyn AuthorityRepository) -> AuthorityResult<T> + Send + 'static,
    ) -> AuthorityResult<T> {
        self.storage
            .execute(move |db| {
                let mut repository = SqliteAuthorityRepository::new(db);
                Ok(operation(&mut repository))
            })
            .await
            .map_err(|error| AuthorityError::storage(error.code(), error.message()))?
    }
    pub(crate) async fn admit(
        &self,
        input: AuthorityAdmissionInput,
    ) -> AuthorityResult<AuthorityAdmissionResult> {
        let collation = self.collation.clone();
        let clock = self.clock.clone();
        let uuid = self.uuid.clone();
        self.in_lane(move |repo| admission::admit(repo, input, &collation, &*clock, &*uuid))
            .await
    }
    pub(crate) async fn list(&self, owner_session_id: String) -> AuthorityResult<Vec<Value>> {
        let collation = self.collation.clone();
        self.in_lane(move |repo| {
            repo.list_pending(&owner_session_id)?
                .iter()
                .map(|record| projection::request(record, &collation))
                .collect()
        })
        .await
    }
    pub(crate) async fn decide(
        &self,
        input: AuthorityDecisionInput,
    ) -> AuthorityResult<AuthorityDecisionResult> {
        let collation = self.collation.clone();
        let clock = self.clock.clone();
        self.in_lane(move |repo| decision::decide(repo, &input, &collation, &*clock))
            .await
    }
    pub(crate) async fn list_decided(&self) -> AuthorityResult<Vec<AuthorityDecisionResult>> {
        self.in_lane(move |repo| {
            repo.list_decided()?
                .iter()
                .map(projection::decision)
                .collect()
        })
        .await
    }
    pub(crate) async fn execution(
        &self,
        input: AuthorityExecutionInput,
    ) -> AuthorityResult<AuthorityStoredExecution> {
        self.in_lane(move |repo| execution::execution(repo, &input))
            .await
    }
    pub(crate) async fn record_outcome(&self, input: AuthorityOutcomeInput) -> AuthorityResult<()> {
        let collation = self.collation.clone();
        let clock = self.clock.clone();
        self.in_lane(move |repo| execution::record_outcome(repo, input, &collation, &*clock))
            .await
    }
    pub(crate) async fn resume_source(
        &self,
        request_ref: String,
    ) -> AuthorityResult<Option<AuthorityResumeSource>> {
        self.in_lane(move |repo| repo.resume_source(&request_ref))
            .await
    }
    pub(crate) async fn waiting_source_sessions(&self) -> AuthorityResult<Vec<String>> {
        self.in_lane(|repo| repo.waiting_source_sessions()).await
    }
    pub(crate) async fn list_permissions(
        &self,
        owner_session_id: String,
    ) -> AuthorityResult<Vec<ConversationPermission>> {
        self.in_lane(move |repo| repo.list_permissions(&owner_session_id))
            .await
    }
    pub(crate) async fn revoke_permission(
        &self,
        owner_session_id: String,
        grant_ref: String,
    ) -> AuthorityResult<()> {
        let clock = self.clock.clone();
        self.in_lane(move |repo| repo.revoke_permission(&owner_session_id, &grant_ref, &clock()))
            .await
    }
    pub(crate) async fn close_self_session(
        &self,
        session_id: String,
        reason: String,
    ) -> AuthorityResult<AuthorityOperationalCloseResult> {
        let clock = self.clock.clone();
        self.in_lane(move |repo| {
            identity::required(&session_id, "self session")?;
            let count = repo.close_self(&session_id, &reason, &clock())?;
            Ok(AuthorityOperationalCloseResult {
                scope: "self_session",
                reason,
                closed_count: count,
            })
        })
        .await
    }
}
