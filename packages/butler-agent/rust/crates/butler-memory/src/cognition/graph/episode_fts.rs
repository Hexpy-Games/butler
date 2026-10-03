//! Versioned multilingual episode projection. All writes run under the cache lease.
pub(super) mod read;
mod schema;
mod tokenize;
use super::{GraphRepository, db_error};
use crate::cognition::CognitionResult;
pub(super) use read::select;
use rusqlite::{Connection, OptionalExtension, params};
pub(super) use schema::install;
use tokio_util::sync::CancellationToken;

impl GraphRepository {
    pub(in crate::cognition) fn advance_episode_fts(
        &mut self,
        stop: &CancellationToken,
    ) -> CognitionResult<bool> {
        let tx = self.connection_mut()?.transaction().map_err(db_error)?;
        let ids = {
            let mut statement = tx.prepare("SELECT episode_id FROM memory_episode_fts_pending ORDER BY episode_id LIMIT 32").map_err(db_error)?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
        };
        if ids.is_empty() {
            return Ok(false);
        }
        for id in &ids {
            if stop.is_cancelled() {
                return Err(crate::cognition::CognitionError::new(
                    crate::cognition::CognitionCode::MemoryOperationAborted,
                    "memory_operation_aborted",
                ));
            }
            project(&tx, id)?;
            tx.execute(
                "DELETE FROM memory_episode_fts_pending WHERE episode_id=?1",
                [id],
            )
            .map_err(db_error)?;
        }
        tx.execute(
            "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
            [],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(true)
    }
}

fn project(db: &Connection, id: &str) -> CognitionResult<()> {
    db.execute("DELETE FROM memory_episode_fts_v1 WHERE rowid=(SELECT id FROM memory_episode_fts_meta WHERE episode_id=?1)",[id]).map_err(db_error)?;
    db.execute(
        "DELETE FROM memory_episode_fts_meta WHERE episode_id=?1",
        [id],
    )
    .map_err(db_error)?;
    let chunk = db.query_row("SELECT current_revision,COALESCE(summary,''),project_id,conversation_session_id FROM memory_chunks WHERE memory_chunk_id=?1 AND status='active'", [id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?))).optional().map_err(db_error)?;
    let Some((revision, summary, project, session)) = chunk else {
        return Ok(());
    };
    let sources = texts(
        db,
        &format!(
            "SELECT t.text FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id JOIN memory_source_text t ON t.source_id=s.source_id WHERE {ELIGIBLE} ORDER BY s.source_id"
        ),
        id,
    )?;
    if sources.is_empty() {
        return Ok(());
    }
    let entities = texts(db, &format!("SELECT DISTINCT surface FROM (SELECT a.surface_original surface FROM memory_aliases a JOIN memory_chunk_sources s ON s.source_id=a.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE {ELIGIBLE} UNION SELECT n.label_original FROM memory_evidence e JOIN memory_nodes n ON n.id=e.node_id JOIN memory_chunk_sources s ON s.source_id=e.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE {ELIGIBLE} AND n.type!='project' AND NOT EXISTS(SELECT 1 FROM memory_claims p WHERE p.node_id=n.id)) ORDER BY surface"), id)?.join(" ");
    let claims = texts(db, &format!("SELECT DISTINCT p.statement FROM memory_claims p JOIN memory_evidence e ON e.node_id=p.node_id JOIN memory_chunk_sources s ON s.source_id=e.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE {ELIGIBLE} ORDER BY p.statement"), id)?.join(" ");
    let source = sources.join(" ");
    let refs: String = db
        .query_row(&format!("SELECT json_group_array(source_id) FROM (SELECT s.source_id FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE {ELIGIBLE} ORDER BY s.source_id)"), [id], |row| row.get(0))
        .map_err(db_error)?;
    let hash = crate::cognition::sources::projection_hash_for_graph(&(
        &revision, &summary, &entities, &claims, &source, &refs,
    ))?;
    db.execute("INSERT INTO memory_episode_fts_meta(episode_id,revision,project_id,session_id,source_refs_json,content_hash,observed_at) VALUES(?1,?2,?3,?4,?5,?6,(SELECT MAX(observed_at) FROM memory_chunk_sources WHERE episode_id=?1 AND revision=?2))",params![id,revision,project,session,refs,hash]).map_err(db_error)?;
    let rowid = db.last_insert_rowid();
    db.execute("INSERT INTO memory_episode_fts_v1(rowid,summary,entities,claims,source) VALUES(?1,?2,?3,?4,?5)",params![rowid,tokenize::field(&summary),tokenize::field(&entities),tokenize::field(&claims),tokenize::field(&source)]).map_err(db_error)?;
    Ok(())
}

fn texts(db: &Connection, sql: &str, id: &str) -> CognitionResult<Vec<String>> {
    let mut statement = db.prepare(sql).map_err(db_error)?;
    statement
        .query_map([id], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

const ELIGIBLE: &str = "s.episode_id=?1 AND c.current_revision=s.revision AND ((s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public')) OR (s.source_kind='task_report' AND s.role='task' AND s.basis='reviewed_task') OR (s.source_kind='explicit_record' AND s.role='explicit' AND s.basis='user_statement'))";
