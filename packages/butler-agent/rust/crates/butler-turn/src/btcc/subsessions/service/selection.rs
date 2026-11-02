//! Relation ownership and eligibility for parent control.
use super::{SubsessionService, error};
use crate::btcc::{BtccCode, BtccError, StoredSubsessionDelegation};
use crate::workspace::SessionRole;
impl SubsessionService {
    /// Select one eligible relation, or one closed relation for structured
    /// direction feedback. Open/blocked Work keeps its original owner.
    /// Cancellation only addresses unfinished relations.
    pub(super) async fn select_relation(
        &self,
        query: RelationQuery<'_>,
    ) -> Result<StoredSubsessionDelegation, BtccError> {
        let candidates = self.candidate_relations(&query).await?;
        let owned = self.owned_relations(&query, candidates).await?;
        let mut eligible = Vec::new();
        let mut closed = Vec::new();
        for candidate in owned {
            if self.relation_is_eligible(&candidate).await? {
                eligible.push(candidate);
            } else if query.purpose == RelationPurpose::Direct {
                closed.push(candidate);
            }
        }
        let mut eligible = eligible.into_iter();
        match (eligible.next(), eligible.next()) {
            (None, _) if query.purpose == RelationPurpose::Direct && closed.len() == 1 => closed
                .pop()
                .ok_or_else(|| error(BtccCode::ActiveStewardRelationNotFound)),
            (None, _) => Err(error(BtccCode::ActiveStewardRelationNotFound)),
            (Some(relation), None) => Ok(relation),
            (Some(_), Some(_)) => Err(error(BtccCode::ActiveStewardRelationAmbiguous)),
        }
    }

    /// Relations of the addressed role matching the id and title filters: by
    /// Work when directing with a Work id, else the parent's relations.
    async fn candidate_relations(
        &self,
        query: &RelationQuery<'_>,
    ) -> Result<Vec<StoredSubsessionDelegation>, BtccError> {
        let addressed = match query.work_id {
            Some(work) => self
                .repository
                .relation_by_work(work.into())
                .await
                .map_err(BtccError::from)?
                .map(|relation| relation.relation_id),
            None => None,
        };
        let mut candidates = match (query.purpose, query.work_id, query.relation_id) {
            (_, _, Some(id)) => self
                .repository
                .relation_by_id(id.into())
                .await
                .map_err(BtccError::from)?
                .into_iter()
                .collect(),
            (RelationPurpose::Direct, Some(work), None) => self
                .repository
                .relation_by_work(work.into())
                .await
                .map_err(BtccError::from)?
                .into_iter()
                .collect(),
            _ => self
                .repository
                .relations_for_parent(query.parent.into())
                .await
                .map_err(BtccError::from)?,
        };
        let role = if *query.role == SessionRole::Worker {
            "worker"
        } else {
            "steward"
        };
        candidates.retain(|candidate| {
            (query.work_id.is_none() || addressed.as_ref() == Some(&candidate.relation_id))
                && query
                    .relation_id
                    .is_none_or(|id| candidate.relation_id == id)
                && (query.relation_id.is_some()
                    || query.work_id.is_some()
                    || query
                        .title
                        .is_none_or(|value| candidate.safe_title == value))
                && candidate.packet.child_role.as_str() == role
        });
        Ok(candidates)
    }

    /// Keeps the relations the parent may address: its own children, or with
    /// a Work id, children bound to the same ledger and app project.
    async fn owned_relations(
        &self,
        query: &RelationQuery<'_>,
        candidates: Vec<StoredSubsessionDelegation>,
    ) -> Result<Vec<StoredSubsessionDelegation>, BtccError> {
        let source = self
            .bindings
            .get_by_session_id(query.parent)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::StewardFollowupAuthorityMismatch))?;
        let expected_parent = if *query.role == SessionRole::Worker {
            SessionRole::Steward
        } else {
            SessionRole::Butler
        };
        if source.role != expected_parent {
            return Err(error(BtccCode::StewardFollowupAuthorityMismatch));
        }
        let source_project = source
            .app_project_id
            .as_ref()
            .or(source.project_id.as_ref());
        let mut owned = Vec::new();
        for candidate in candidates {
            let child = self
                .bindings
                .get_by_session_id(&candidate.child_session_id)
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::StewardFollowupAuthorityMismatch))?;
            let same_parent = candidate.parent_session_id == query.parent;
            let same_project = query.work_id.is_some()
                && source.ledger_project_id.is_some()
                && source.ledger_project_id == child.ledger_project_id
                && source_project.is_some()
                && source_project == child.app_project_id.as_ref().or(child.project_id.as_ref());
            if same_parent || same_project {
                owned.push(candidate);
            }
        }
        Ok(owned)
    }

    /// An unfinished assignment remains eligible while its queue drains.
    pub(super) async fn relation_is_eligible(
        &self,
        candidate: &StoredSubsessionDelegation,
    ) -> Result<bool, BtccError> {
        let terminal = self
            .repository
            .result_for_relation(candidate.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some();
        if !terminal {
            return Ok(true);
        }
        if self
            .repository
            .has_pending_direction(candidate.relation_id.clone())
            .await
            .map_err(BtccError::from)?
        {
            return Ok(true);
        }
        // Results end assignments. A queued continuation remains eligible only
        // while its own latest turn is actually running.
        self.child_turn_running(&candidate.child_session_id).await
    }
}

/// Why a parent addresses one of its subsession relations.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RelationPurpose {
    /// Send direction, returning feedback when the assignment has ended.
    Direct,
    /// Cancel an unfinished relation.
    Cancel,
}

/// Which relation a direction or cancellation addresses.
pub(super) struct RelationQuery<'a> {
    pub(super) parent: &'a str,
    pub(super) relation_id: Option<&'a str>,
    pub(super) work_id: Option<&'a str>,
    pub(super) title: Option<&'a str>,
    pub(super) role: &'a SessionRole,
    pub(super) purpose: RelationPurpose,
}
