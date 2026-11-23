//! Accepted child file results, read by exact result identity or the owning Steward.
use super::{SqliteSubsessionRepository, StorageError};
use crate::btcc::{JournalCloseout, StorageCode};

impl SqliteSubsessionRepository {
    /// Reads accepted payloads only from this parent's durable relations. A Butler
    /// result turn names its exact result; a Steward owns its worker results,
    /// whose declarations arrive as working files.
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
                        "SELECT t.final_payload_json, r.activity_role FROM btcc_session_relations r \
                 JOIN btcc_steward_results x ON x.relation_id=r.relation_id \
                 JOIN btcc_turns t ON t.turn_id=x.child_turn_id \
                 WHERE r.parent_session_id=?1 AND x.status<>'cancelled' \
                 AND (x.result_id=?2 OR (?3 AND r.activity_role='worker')) \
                 ORDER BY x.created_at,x.result_id",
                    )
                    .map_err(StorageError::sqlite)?;
                let rows = statement
                    .query_map(rusqlite::params![parent, result, workers], |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    })
                    .map_err(StorageError::sqlite)?;
                let mut files = JournalCloseout {
                    outputs: Vec::new(),
                    documents: Vec::new(),
                    artifacts: Vec::new(),
                    changed_files: Vec::new(),
                    answer_blocks: Vec::new(),
                };
                for raw in rows {
                    let (raw, role) = raw.map_err(StorageError::sqlite)?;
                    let Some(raw) = raw else { continue };
                    // A Worker's declarations are inputs to its Steward, never the user's deliverables.
                    let worker = role.as_deref() == Some("worker");
                    let payload: serde_json::Value = serde_json::from_str(&raw).map_err(invalid)?;
                    if !worker {
                        if let Some(value) = payload.get("outputs") {
                            files.outputs.extend(
                                serde_json::from_value::<Vec<String>>(value.clone())
                                    .map_err(invalid)?,
                            );
                        }
                        if let Some(value) = payload.get("documents") {
                            files.documents.extend(
                                serde_json::from_value::<Vec<String>>(value.clone())
                                    .map_err(invalid)?,
                            );
                        }
                    }
                    if let Some(value) = payload.get("artifacts") {
                        let mut items = serde_json::from_value::<Vec<crate::btcc::FinalArtifact>>(
                            value.clone(),
                        )
                        .map_err(invalid)?;
                        if worker {
                            for artifact in &mut items {
                                artifact.deliverable = false;
                            }
                        }
                        files.artifacts.extend(items);
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
