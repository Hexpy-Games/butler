//! App session progress reads use the existing BTCC lane and latest Turn binding.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use super::{SessionWorkRepository, StorageError, StorageResult};
use crate::btcc::BtccError;

/// Project-scoped facts must be resolved by the canonical Ledger owner outside
/// the BTCC lane. A session plan is already authoritative in this database.
pub(crate) enum SessionPlanObservation {
    Session {
        approved: bool,
        action_keys: Vec<String>,
        completed_action_keys: Vec<String>,
    },
    Project {
        work_id: String,
        app_project_id: String,
        ledger_project_id: String,
    },
}

impl SessionWorkRepository {
    pub(crate) async fn observe_session_plan(
        &self,
        session_id: String,
    ) -> Result<Option<SessionPlanObservation>, BtccError> {
        self.read(move |db| observe(db, &session_id)).await
    }
}

struct BoundWork {
    id: String,
    scope: String,
    scope_ref: String,
    ledger_project_id: Option<String>,
    current_plan: Option<String>,
}

fn observe(db: &Connection, session_id: &str) -> StorageResult<Option<SessionPlanObservation>> {
    let work = db
        .query_row(
            "SELECT work.work_id, work.scope_kind, work.scope_ref,
                work.ledger_project_id, work.current_plan_revision_id
         FROM btcc_guided_turn_work_bindings binding
         JOIN btcc_guided_works work ON work.work_id = binding.work_id
           AND work.session_id = binding.session_id
         WHERE binding.turn_id = (
           SELECT turn_id FROM btcc_turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1
         ) AND binding.is_current = 1",
            [session_id],
            |row| {
                Ok(BoundWork {
                    id: row.get(0)?,
                    scope: row.get(1)?,
                    scope_ref: row.get(2)?,
                    ledger_project_id: row.get(3)?,
                    current_plan: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some(work) = work else { return Ok(None) };
    if work.scope == "project" {
        return Ok(work
            .ledger_project_id
            .filter(|id| !id.is_empty())
            .map(|ledger_project_id| SessionPlanObservation::Project {
                work_id: work.id,
                app_project_id: work.scope_ref,
                ledger_project_id,
            }));
    }
    let plan: Option<(String, String)> = db
        .query_row(
            "SELECT plan_revision_id, actions_json FROM btcc_guided_work_plan_revisions
         WHERE work_id = ? AND plan_revision_id = ?",
            rusqlite::params![work.id, work.current_plan],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some((revision, actions)) = plan else {
        return Ok(None);
    };
    let action_keys = records(&actions)
        .filter_map(|action| {
            action.get("description")?.as_str()?;
            Some(action.get("actionKey")?.as_str()?.to_owned())
        })
        .collect::<Vec<_>>();
    if action_keys.is_empty() {
        return Ok(None);
    }
    let checkpoint: Option<(String, String)> = db
        .query_row(
            "SELECT plan_revision_id, action_states_json FROM btcc_guided_work_checkpoint_revisions
         WHERE work_id = ? ORDER BY revision DESC LIMIT 1",
            [&work.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let completed_action_keys = checkpoint
        .filter(|(bound, _)| *bound == revision)
        .map(|(_, states)| {
            records(&states)
                .filter_map(|action| {
                    if !matches!(action.get("status")?.as_str()?, "done" | "skipped") {
                        return None;
                    }
                    Some(action.get("actionKey")?.as_str()?.to_owned())
                })
                .collect()
        })
        .unwrap_or_default();
    let review: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT verdict, bound_plan_revision_id FROM btcc_guided_work_review_revisions
         WHERE work_id = ? AND subject = 'plan' ORDER BY revision DESC LIMIT 1",
            [&work.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let approved = review
        .is_some_and(|(verdict, bound)| verdict == "accept" && bound.as_deref() == Some(&revision));
    Ok(Some(SessionPlanObservation::Session {
        approved,
        action_keys,
        completed_action_keys,
    }))
}

fn records(raw: &str) -> impl Iterator<Item = Value> {
    match serde_json::from_str(raw) {
        Ok(Value::Array(values)) => values,
        _ => Vec::new(),
    }
    .into_iter()
    .filter(Value::is_object)
}
