use std::sync::Arc;

use super::contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityDecisionInput,
    AuthorityDecisionResult, AuthorityError, AuthorityExecutionInput,
    AuthorityOperationalCloseResult, AuthorityOutcomeInput, AuthorityRepository, AuthorityResult,
    AuthorityResumeSource, AuthorityStoredExecution, ConversationPermission, PrincipalAuthority,
};
use super::{admission, decision, execution, identity, projection};
use crate::btcc::storage::{BtccStorage, SqliteAuthorityRepository};
use butler_core::locale::LocaleCollation;

impl PrincipalAuthority {
    /// Whether the turn still holds an approval it must not release.
    pub async fn retains_approval_claim(&self, turn_id: String) -> AuthorityResult<bool> {
        self.in_lane(move |repo| repo.retains_approval_claim(&turn_id))
            .await
    }
    /// An authority over the store, collation, clock and id source.
    pub fn new(
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
    pub(super) async fn in_lane<T: Send + 'static>(
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
    /// Admits a reviewed operation (see `AuthorityAdmissionResult`).
    pub async fn admit(
        &self,
        input: AuthorityAdmissionInput,
    ) -> AuthorityResult<AuthorityAdmissionResult> {
        let collation = self.collation.clone();
        let clock = self.clock.clone();
        let uuid = self.uuid.clone();
        self.in_lane(move |repo| admission::admit(repo, input, &collation, &*clock, &*uuid))
            .await
    }
    /// The owner's pending requests.
    pub async fn list(
        &self,
        owner_session_id: String,
    ) -> AuthorityResult<Vec<super::contracts::AuthorityRequestProjection>> {
        let collation = self.collation.clone();
        self.in_lane(move |repo| {
            repo.list_pending(&owner_session_id)?
                .iter()
                .map(|record| projection::request(record, &collation))
                .collect()
        })
        .await
    }
    /// Records the user's decision.
    pub async fn decide(
        &self,
        input: AuthorityDecisionInput,
    ) -> AuthorityResult<AuthorityDecisionResult> {
        let collation = self.collation.clone();
        let clock = self.clock.clone();
        self.in_lane(move |repo| decision::decide(repo, &input, &collation, &*clock))
            .await
    }
    /// Decided requests whose source turns have not resumed yet.
    pub async fn list_decided(&self) -> AuthorityResult<Vec<AuthorityDecisionResult>> {
        self.in_lane(move |repo| {
            repo.list_decided()?
                .iter()
                .map(projection::decision)
                .collect()
        })
        .await
    }
    /// Claims execution of an allowed request.
    pub async fn execution(
        &self,
        input: AuthorityExecutionInput,
    ) -> AuthorityResult<AuthorityStoredExecution> {
        self.in_lane(move |repo| execution::execution(repo, &input))
            .await
    }
    /// Records the outcome of an allowed operation.
    pub async fn record_outcome(&self, input: AuthorityOutcomeInput) -> AuthorityResult<()> {
        let collation = self.collation.clone();
        let clock = self.clock.clone();
        self.in_lane(move |repo| execution::record_outcome(repo, input, &collation, &*clock))
            .await
    }
    /// The source turn to resume for a decided request.
    pub async fn resume_source(
        &self,
        request_ref: String,
    ) -> AuthorityResult<Option<AuthorityResumeSource>> {
        self.in_lane(move |repo| repo.resume_source(&request_ref))
            .await
    }
    /// Sessions with turns waiting on an authority decision.
    pub async fn waiting_source_sessions(&self) -> AuthorityResult<Vec<String>> {
        self.in_lane(|repo| repo.waiting_source_sessions()).await
    }
    /// Visible conversations waiting for a principal decision (including delegated work).
    pub async fn attention_owners(&self, owners: Vec<String>) -> AuthorityResult<Vec<String>> {
        self.in_lane(move |repo| repo.attention_owners(&owners))
            .await
    }
    /// The owner's standing conversation permissions.
    pub async fn list_permissions(
        &self,
        owner_session_id: String,
    ) -> AuthorityResult<Vec<ConversationPermission>> {
        let collation = self.collation.clone();
        self.in_lane(move |repo| {
            let mut grants = repo.list_permissions(&owner_session_id)?;
            let mut sources = std::collections::HashMap::new();
            for record in repo.permission_records(&owner_session_id)? {
                let grant = super::permission::for_record(&record, &collation)?;
                sources.insert(grant.grant_ref.clone(), grant);
            }
            for grant in &mut grants {
                if let Some(source) = sources.remove(&grant.grant_ref) {
                    grant.capability = source.capability;
                    grant.target = source.target;
                    grant.cwd = source.cwd;
                }
            }
            Ok(grants)
        })
        .await
    }
    /// Revokes a standing permission.
    pub async fn revoke_permission(
        &self,
        owner_session_id: String,
        grant_ref: String,
    ) -> AuthorityResult<()> {
        let clock = self.clock.clone();
        self.in_lane(move |repo| repo.revoke_permission(&owner_session_id, &grant_ref, &clock()))
            .await
    }
    /// Operationally closes a session's pending requests.
    pub async fn close_self_session(
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
