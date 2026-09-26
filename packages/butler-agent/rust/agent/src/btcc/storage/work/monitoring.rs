//! Bounded, source-shaped Work monitor reads from the existing BTCC owner.

use crate::btcc::BtccError;

use super::{SessionWorkRepository, StorageError};

#[derive(Clone, Debug)]
pub(crate) struct WorkStatusObservation {
    pub work_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub work_status: String,
    pub disposition_status: Option<String>,
    pub runtime_owned_open: bool,
    pub turn_state: Option<String>,
    pub safe_title: Option<String>,
    pub summary: Option<String>,
    pub stage: Option<String>,
    pub action_progress: Vec<String>,
    pub effect_count: u64,
    pub unresolved_blocker_count: u64,
    pub work_updated_at: String,
    pub disposition_updated_at: Option<String>,
    pub checkpoint_updated_at: Option<String>,
    pub operational_notice: Option<WorkStatusOperationalNotice>,
}

#[derive(Clone, Debug)]
pub(crate) struct WorkStatusOperationalNotice {
    pub status: String,
    pub summary: String,
    pub created_at: String,
}

struct WorkStatusCandidate {
    work_id: String,
    session_id: String,
    turn_id: Option<String>,
    work_status: String,
    disposition_status: Option<String>,
    runtime_owned_open: bool,
    turn_state: Option<String>,
    safe_title: Option<String>,
    summary: Option<String>,
    stage: Option<String>,
    action_progress: Vec<String>,
    effect_count: u64,
    unresolved_blocker_count: u64,
    work_updated_at: String,
    disposition_updated_at: Option<String>,
    checkpoint_updated_at: Option<String>,
}

fn operational_notice(event_json: &str, created_at: String) -> Option<WorkStatusOperationalNotice> {
    let event: serde_json::Value = serde_json::from_str(event_json).ok()?;
    if event.get("kind").and_then(serde_json::Value::as_str) != Some("assistant.public_note")
        || event.get("visibility").and_then(serde_json::Value::as_str) != Some("public")
    {
        return None;
    }
    let payload = event.get("payload")?;
    if payload
        .get("bridgePhase")
        .and_then(serde_json::Value::as_str)
        != Some("operational_recovery")
    {
        return None;
    }
    let status = payload
        .get("recoveryStatus")
        .and_then(serde_json::Value::as_str)?;
    if !matches!(status, "recovering" | "interrupted" | "cleared") {
        return None;
    }
    Some(WorkStatusOperationalNotice {
        status: status.into(),
        summary: payload
            .get("note")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Operational status changed.")
            .into(),
        created_at,
    })
}

impl SessionWorkRepository {
    /// Read bounded source-shaped Work monitor facts without starting other owners.
    pub(crate) async fn work_status_observations(
        &self,
    ) -> Result<Vec<WorkStatusObservation>, BtccError> {
        self.read(|db| {
            let mut statement = db
                .prepare(
                    "SELECT work.work_id, work.session_id, work.status, work.updated_at, \
                 turn.turn_id, turn.semantic_state, relation.safe_title, \
                 disposition.disposition, disposition.runtime_owned_open, \
                 disposition.created_at, checkpoint.stage, checkpoint.public_summary, \
                 checkpoint.action_states_json, checkpoint.created_at, \
                 (SELECT COUNT(*) FROM btcc_guided_work_effect_blockers blocker \
                   WHERE blocker.work_id = work.work_id AND blocker.status = 'unresolved'), \
                 (SELECT COUNT(*) FROM btcc_guided_effects effect \
                   WHERE effect.work_id = work.work_id) \
                 FROM btcc_guided_works work \
                 LEFT JOIN btcc_guided_turn_work_bindings binding \
                   ON binding.rowid = (SELECT candidate.rowid \
                     FROM btcc_guided_turn_work_bindings candidate \
                     WHERE candidate.work_id = work.work_id \
                     ORDER BY candidate.bound_at DESC, candidate.rowid DESC LIMIT 1) \
                 LEFT JOIN btcc_turns turn ON turn.turn_id = binding.turn_id \
                 LEFT JOIN btcc_session_relations relation \
                   ON relation.child_session_id = work.session_id \
                 LEFT JOIN btcc_guided_work_disposition_revisions disposition \
                   ON disposition.work_id = work.work_id AND disposition.revision = (\
                     SELECT MAX(candidate.revision) \
                     FROM btcc_guided_work_disposition_revisions candidate \
                     WHERE candidate.work_id = work.work_id) \
                 LEFT JOIN btcc_guided_work_checkpoint_revisions checkpoint \
                   ON checkpoint.work_id = work.work_id AND checkpoint.revision = (\
                     SELECT MAX(candidate.revision) \
                     FROM btcc_guided_work_checkpoint_revisions candidate \
                     WHERE candidate.work_id = work.work_id) \
                 WHERE work.status != 'abandoned' \
                 ORDER BY CASE WHEN work.status IN ('open', 'blocked') THEN 0 ELSE 1 END, \
                   work.updated_at DESC LIMIT 24",
                )
                .map_err(StorageError::sqlite)?;
            let candidates = statement
                .query_map([], |row| {
                    let action_states = row.get::<_, Option<String>>(12)?;
                    let action_progress = action_states
                        .as_deref()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                        .and_then(|value| value.as_array().cloned())
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|action| {
                            action
                                .get("status")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        })
                        .collect();
                    Ok(WorkStatusCandidate {
                        work_id: row.get(0)?,
                        session_id: row.get(1)?,
                        work_status: row.get(2)?,
                        work_updated_at: row.get(3)?,
                        turn_id: row.get(4)?,
                        turn_state: row.get(5)?,
                        safe_title: row.get(6)?,
                        disposition_status: row.get(7)?,
                        runtime_owned_open: row.get::<_, Option<i64>>(8)?.unwrap_or(0) == 1,
                        disposition_updated_at: row.get(9)?,
                        stage: row.get(10)?,
                        summary: row.get(11)?,
                        action_progress,
                        checkpoint_updated_at: row.get(13)?,
                        unresolved_blocker_count: u64::try_from(row.get::<_, i64>(14)?.max(0))
                            .unwrap_or_default(),
                        effect_count: u64::try_from(row.get::<_, i64>(15)?.max(0))
                            .unwrap_or_default(),
                    })
                })
                .map_err(StorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::sqlite)?;
            drop(statement);

            let mut notices = db
                .prepare(
                    "SELECT progress.event_json, progress.created_at \
                     FROM btcc_progress_events progress \
                     JOIN btcc_guided_turn_work_bindings binding \
                       ON binding.turn_id = progress.turn_id \
                     WHERE binding.work_id = ?1 \
                     ORDER BY progress.session_sequence DESC, progress.event_id DESC LIMIT 32",
                )
                .map_err(StorageError::sqlite)?;
            let mut observations = Vec::with_capacity(candidates.len());
            for candidate in candidates {
                let notice = notices
                    .query_map([&candidate.work_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(StorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)?
                    .into_iter()
                    .find_map(|(event, created_at)| operational_notice(&event, created_at));
                observations.push(WorkStatusObservation {
                    work_id: candidate.work_id,
                    session_id: candidate.session_id,
                    turn_id: candidate.turn_id,
                    work_status: candidate.work_status,
                    disposition_status: candidate.disposition_status,
                    runtime_owned_open: candidate.runtime_owned_open,
                    turn_state: candidate.turn_state,
                    safe_title: candidate.safe_title,
                    summary: candidate.summary,
                    stage: candidate.stage,
                    action_progress: candidate.action_progress,
                    effect_count: candidate.effect_count,
                    unresolved_blocker_count: candidate.unresolved_blocker_count,
                    work_updated_at: candidate.work_updated_at,
                    disposition_updated_at: candidate.disposition_updated_at,
                    checkpoint_updated_at: candidate.checkpoint_updated_at,
                    operational_notice: notice,
                });
            }
            Ok(observations)
        })
        .await
    }
}
