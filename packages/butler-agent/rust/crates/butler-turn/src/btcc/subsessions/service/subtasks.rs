//! Unfinished delegated subtasks per conversation, for the App's lists and panel.

use serde::Serialize;

use super::SubsessionService;
use crate::btcc::BtccError;

/// What an unfinished subtask is doing, from the owner's point of view.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtaskState {
    Working,
    /// Interrupted and resumable by the owner.
    Paused,
    /// Waiting on the owner's decision somewhere in its subtree.
    NeedsApproval,
}

impl SubtaskState {
    /// A pending decision wins over an interruption: the owner acts on it first.
    #[must_use]
    pub fn of(awaiting_decision: bool, recoverable: bool) -> Self {
        if awaiting_decision {
            Self::NeedsApproval
        } else if recoverable {
            Self::Paused
        } else {
            Self::Working
        }
    }
}

/// One unfinished steward child of a conversation.
#[derive(Clone, Debug, Serialize)]
pub struct OpenSubtask {
    #[serde(skip)]
    pub parent_session_id: String,
    pub session_id: String,
    pub relation_id: String,
    pub title: String,
    pub state: SubtaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_completed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_total: Option<usize>,
    pub started_at: String,
}

impl SubsessionService {
    /// Unfinished subtasks of the given runtime sessions, in start order.
    /// Bounded by their open children; finished children are never read.
    pub async fn open_subtasks(&self, parents: Vec<String>) -> Result<Vec<OpenSubtask>, BtccError> {
        let rows = self
            .repository
            .open_subtasks(parents)
            .await
            .map_err(BtccError::from)?;
        let mut subtasks = Vec::with_capacity(rows.len());
        for row in rows {
            let relation = &row.relation;
            let recoverable = !row.awaiting_decision && self.child_recoverable(relation).await?;
            let latest = self
                .repository
                .latest_turn(relation.child_session_id.clone())
                .await
                .map_err(BtccError::from)?;
            let plan = match &latest {
                Some((turn, _)) => self.plan_progress(turn).await?,
                None => None,
            };
            subtasks.push(OpenSubtask {
                parent_session_id: row.parent,
                session_id: relation.child_session_id.clone(),
                relation_id: relation.relation_id.clone(),
                title: super::helpers::delegation_title(
                    Some(&relation.safe_title),
                    &relation.packet.objective,
                ),
                state: SubtaskState::of(row.awaiting_decision, recoverable),
                plan_completed: plan.map(|(_, _, completed)| completed),
                plan_total: plan.map(|(_, total, _)| total),
                started_at: relation.created_at.clone(),
            });
        }
        Ok(subtasks)
    }
}
