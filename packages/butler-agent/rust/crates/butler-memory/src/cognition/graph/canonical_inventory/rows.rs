//! Row reads and writes of the canonical inventory mirror.

use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};

use super::{COVERED, db_error};
use crate::cognition::sources::{CandidateKind, EligibleSource, InventoryCandidate, SourceFault};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};

/// Which uncovered rows a recall reads.
pub(in crate::cognition) struct Uncovered<'a> {
    /// Only these sessions (and the faults every recall reports), when the
    /// recall names them.
    pub sessions: Option<&'a [String]>,
    /// Only the rows without a revision: unreadable sources and turns whose
    /// outcome generation is not finite, the rows that can still fail it.
    pub unreadable_only: bool,
}

const EPISODE_COMPLETE: &str = "SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j \
     ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
     WHERE c.memory_chunk_id=?1 AND c.current_revision=?2 \
       AND json_extract(j.semantic_graph_state,'$.state')='complete' LIMIT 1";

pub(super) fn episode_complete(
    db: &Connection,
    episode_id: &str,
    revision: &str,
) -> CognitionResult<bool> {
    Ok(db
        .prepare_cached(EPISODE_COMPLETE)
        .map_err(db_error)?
        .query_row(params![episode_id, revision], |row| row.get::<_, i64>(0))
        .optional()
        .map_err(db_error)?
        .is_some())
}

pub(super) fn visit_uncovered(
    db: &Connection,
    uncovered: &Uncovered<'_>,
    mut visit: impl FnMut(InventoryCandidate) -> CognitionResult<bool>,
) -> CognitionResult<()> {
    let mut sql = String::from(
        "SELECT kind,entity_id,session_id,request_message_id,assistant_message_id,episode_id,revision,created_at_json,fault,fault_every_recall \
         FROM memory_canonical_inventory WHERE eligible=1 AND covered=0",
    );
    if let Some(sessions) = uncovered.sessions {
        sql.push_str(&format!(
            " AND (session_id IN ({}) OR fault_every_recall=1)",
            vec!["?"; sessions.len()].join(",")
        ));
    }
    if uncovered.unreadable_only {
        sql.push_str(" AND revision IS NULL");
    }
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let mut rows = statement
        .query(params_from_iter(uncovered.sessions.unwrap_or_default()))
        .map_err(db_error)?;
    while let Some(row) = rows.next().map_err(db_error)? {
        if !visit(candidate(row)?)? {
            break;
        }
    }
    Ok(())
}

fn candidate(row: &Row<'_>) -> CognitionResult<InventoryCandidate> {
    let fault = row
        .get::<_, Option<String>>(8)
        .map_err(db_error)?
        .map(|message| -> CognitionResult<SourceFault> {
            Ok(SourceFault {
                message,
                every_recall: row.get(9).map_err(db_error)?,
            })
        })
        .transpose()?;
    let created_at: Vec<String> =
        serde_json::from_str(&row.get::<_, String>(7).map_err(db_error)?).map_err(format_error)?;
    Ok(InventoryCandidate {
        kind: kind_from(&row.get::<_, String>(0).map_err(db_error)?)?,
        id: row.get(1).map_err(db_error)?,
        session_id: row.get(2).map_err(db_error)?,
        request_message_id: row.get(3).map_err(db_error)?,
        assistant_message_id: row.get(4).map_err(db_error)?,
        eligible: row
            .get::<_, Option<String>>(5)
            .map_err(db_error)?
            .map(|episode_id| -> CognitionResult<EligibleSource> {
                Ok(EligibleSource {
                    episode_id,
                    revision: row.get(6).map_err(db_error)?,
                    created_at: created_at.clone(),
                })
            })
            .transpose()?,
        fault,
    })
}

pub(super) fn upsert(tx: &Transaction<'_>, candidate: &InventoryCandidate) -> CognitionResult<()> {
    let key = candidate.key();
    let eligible = candidate.eligible.as_ref();
    let created_at = serde_json::to_string(&eligible.map_or(&[][..], |e| &e.created_at[..]))
        .map_err(format_error)?;
    tx.execute(
        "INSERT INTO memory_canonical_inventory(source_key,kind,entity_id,session_id,request_message_id,assistant_message_id,eligible,episode_id,revision,created_at_json,fault,fault_every_recall) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(source_key) DO UPDATE SET kind=excluded.kind,entity_id=excluded.entity_id,\
         session_id=excluded.session_id,request_message_id=excluded.request_message_id,assistant_message_id=excluded.assistant_message_id,\
         eligible=excluded.eligible,episode_id=excluded.episode_id,revision=excluded.revision,created_at_json=excluded.created_at_json,\
         fault=excluded.fault,fault_every_recall=excluded.fault_every_recall",
        params![
            key,
            kind_name(candidate.kind),
            candidate.id,
            candidate.session_id,
            candidate.request_message_id,
            candidate.assistant_message_id,
            eligible.is_some() || candidate.fault.is_some(),
            eligible.map(|e| &e.episode_id),
            eligible.and_then(|e| e.revision.as_ref()),
            created_at,
            candidate.fault.as_ref().map(|fault| &fault.message),
            candidate.fault.as_ref().is_some_and(|fault| fault.every_recall),
        ],
    )
    .map_err(db_error)?;
    tx.execute(
        &format!("UPDATE memory_canonical_inventory SET covered={COVERED} WHERE source_key=?1"),
        [key],
    )
    .map_err(db_error)?;
    Ok(())
}

pub(super) fn referencing(db: &Connection, message_id: &str) -> CognitionResult<Vec<String>> {
    let mut statement = db
        .prepare(
            "SELECT entity_id FROM memory_canonical_inventory WHERE request_message_id=?1 \
             UNION SELECT entity_id FROM memory_canonical_inventory WHERE assistant_message_id=?1",
        )
        .map_err(db_error)?;
    statement
        .query_map([message_id], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn kind_name(kind: CandidateKind) -> &'static str {
    match kind {
        CandidateKind::Turn => "turn",
        CandidateKind::Message => "message",
    }
}

fn kind_from(value: &str) -> CognitionResult<CandidateKind> {
    match value {
        "turn" => Ok(CandidateKind::Turn),
        "message" => Ok(CandidateKind::Message),
        _ => Err(CognitionError::new(
            CognitionCode::MemoryGraphUnavailable,
            "canonical_inventory_kind_invalid",
        )),
    }
}

fn format_error(error: serde_json::Error) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string()).with_source(error)
}
