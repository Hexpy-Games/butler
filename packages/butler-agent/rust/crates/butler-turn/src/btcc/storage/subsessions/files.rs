//! Accepted child file results, read by exact result identity or the owning Steward.
use super::{SqliteSubsessionRepository, StorageError};
use crate::btcc::{JournalCloseout, StorageCode};

impl SqliteSubsessionRepository {
    /// Reads accepted payloads only from this parent's durable relations. A Butler
    /// result turn names its exact result; a Steward owns its worker results.
    pub async fn delivered_files(
        &self,
        parent: String,
        result: Option<String>,
        workers: bool,
    ) -> Result<JournalCloseout, StorageError> {
        self.storage
            .execute(move |db| {
                let mut statement = db
                    .prepare_cached(
                        "SELECT t.final_payload_json,x.created_at AS at,x.result_id AS identity FROM btcc_session_relations r \
                 JOIN btcc_steward_results x ON x.relation_id=r.relation_id \
                 JOIN btcc_turns t ON t.turn_id=x.child_turn_id \
                 WHERE r.parent_session_id=?1 AND x.status<>'cancelled' \
                 AND (x.result_id=?2 OR (?3 AND r.activity_role='worker')) \
                 UNION ALL SELECT t.final_payload_json,strftime('%Y-%m-%dT%H:%M:%fZ',a.finished_at/1000.0,'unixepoch'), 'result-'||a.id \
                 FROM btcc_session_relations r JOIN wm_session_exec s ON s.session_id=r.child_session_id \
                 JOIN wm_attempts a ON a.task_id=s.current_task_id AND a.session_id=r.child_session_id \
                 JOIN btcc_turns t ON t.turn_id=a.turn_id \
                 WHERE r.parent_session_id=?1 AND a.status='succeeded' \
                 AND ('result-'||a.id=?2 OR (?3 AND r.activity_role='worker')) ORDER BY at,identity",
                    )
                    .map_err(StorageError::sqlite)?;
                let rows = statement
                    .query_map(rusqlite::params![parent, result, workers], |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .map_err(StorageError::sqlite)?;
                let mut files = JournalCloseout {
                    outputs: Vec::new(),
                    artifacts: Vec::new(),
                    changed_files: Vec::new(),
                    answer_blocks: Vec::new(),
                };
                for raw in rows {
                    let Some(raw) = raw.map_err(StorageError::sqlite)? else {
                        continue;
                    };
                    let payload: serde_json::Value = serde_json::from_str(&raw).map_err(invalid)?;
                    if let Some(value) = payload.get("outputs") {
                        files.outputs.extend(
                            serde_json::from_value::<Vec<String>>(value.clone())
                                .map_err(invalid)?,
                        );
                    }
                    if let Some(value) = payload.get("artifacts") {
                        files.artifacts.extend(
                            serde_json::from_value::<Vec<crate::btcc::FinalArtifact>>(
                                value.clone(),
                            )
                            .map_err(invalid)?,
                        );
                    }
                    if let Some(value) = payload.get("changedFiles") {
                        files.changed_files.extend(
                            serde_json::from_value::<Vec<crate::btcc::ChangedFileSummary>>(
                                value.clone(),
                            )
                            .map_err(invalid)?,
                        );
                    }
                }
                Ok(files)
            })
            .await
    }
}
fn invalid(error: serde_json::Error) -> StorageError {
    StorageError::new(StorageCode::SubsessionResultInvalid, error.to_string()).with_source(error)
}
