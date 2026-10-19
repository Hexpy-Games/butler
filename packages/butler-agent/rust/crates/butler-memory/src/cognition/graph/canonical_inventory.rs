//! The canonical source inventory mirrored into the graph, so a recall reads
//! projection coverage from the uncovered rows plus the source changes after
//! the watermark instead of scanning the whole canonical store.
//!
//! One row per turn outcome and recovered message, as
//! [`InventoryCandidate`] describes it before any recall scope or time.
//! `covered` says whether the row's episode revision has a complete semantic
//! projection; triggers on `memory_chunks` and `memory_projection_jobs` keep
//! it exact inside every graph write, so the flag always matches the graph
//! snapshot it is read from. `memory_state` binds the rows to the canonical
//! store identity and its source change sequence.

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::{GraphRecallReader, GraphRepository, db_error};
use crate::cognition::CognitionResult;
use crate::cognition::sources::{CandidateKind, EligibleSource, InventoryCandidate};

/// Row derivation and schema version; a change rebuilds the rows.
const FORMAT: &str = "1";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS memory_canonical_inventory(source_key TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,session_id TEXT NOT NULL,request_message_id TEXT,assistant_message_id TEXT,eligible INTEGER NOT NULL,episode_id TEXT,revision TEXT,created_at_json TEXT NOT NULL,covered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_episode ON memory_canonical_inventory(episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_request ON memory_canonical_inventory(request_message_id) WHERE request_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_answer ON memory_canonical_inventory(assistant_message_id) WHERE assistant_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_uncovered ON memory_canonical_inventory(source_key) WHERE eligible=1 AND covered=0;
";

/// Whether the row's episode revision is completely projected; recall's
/// per-entry coverage test.
const COVERED: &str = "EXISTS(SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE c.memory_chunk_id=memory_canonical_inventory.episode_id AND c.current_revision=memory_canonical_inventory.revision AND CASE WHEN json_valid(j.semantic_graph_state) THEN json_extract(j.semantic_graph_state,'$.state') END='complete')";

const TRIGGERS: [(&str, &str, &str, &str); 6] = [
    (
        "chunk_insert",
        "INSERT ON memory_chunks",
        "NEW.memory_chunk_id",
        "",
    ),
    (
        "chunk_update",
        "UPDATE OF memory_chunk_id,current_revision ON memory_chunks",
        "OLD.memory_chunk_id",
        "NEW.memory_chunk_id",
    ),
    (
        "chunk_delete",
        "DELETE ON memory_chunks",
        "OLD.memory_chunk_id",
        "",
    ),
    (
        "job_insert",
        "INSERT ON memory_projection_jobs",
        "NEW.episode_id",
        "",
    ),
    (
        "job_update",
        "UPDATE OF episode_id,revision,semantic_graph_state ON memory_projection_jobs",
        "OLD.episode_id",
        "NEW.episode_id",
    ),
    (
        "job_delete",
        "DELETE ON memory_projection_jobs",
        "OLD.episode_id",
        "",
    ),
];

/// Where the mirrored inventory stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct InventoryState {
    /// The canonical store the rows describe.
    pub identity: String,
    /// Every source change up to this sequence is reflected in the rows;
    /// during the initial build, the sequence at which it began.
    pub seq: u64,
    pub phase: InventoryPhase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) enum InventoryPhase {
    /// The initial build pages turn outcomes after the cursor.
    Outcomes(Option<String>),
    /// The initial build pages recovered messages after the cursor.
    Messages(Option<String>),
    Ready,
}

/// One transaction of inventory maintenance.
pub(in crate::cognition) struct InventoryWrite {
    /// Drop every row first (another store, or a new build).
    pub reset: bool,
    pub upserts: Vec<InventoryCandidate>,
    pub deletes: Vec<String>,
    pub state: InventoryState,
}

impl GraphRepository {
    /// Creates the inventory table and its coverage triggers; a stored
    /// format other than [`FORMAT`] drops the old rows and state first.
    pub(in crate::cognition) fn install_canonical_inventory(&mut self) -> CognitionResult<()> {
        let db = self.connection_mut()?;
        if read_key(db, "canonical_inventory_format")?.as_deref() == Some(FORMAT) {
            return Ok(());
        }
        let tx = db.transaction().map_err(db_error)?;
        let mut sql = String::from("DROP TABLE IF EXISTS memory_canonical_inventory;");
        for (name, ..) in TRIGGERS {
            sql.push_str(&format!(
                "DROP TRIGGER IF EXISTS canonical_inventory_{name};"
            ));
        }
        sql.push_str("DELETE FROM memory_state WHERE key LIKE 'canonical_inventory_%';");
        sql.push_str(SCHEMA);
        for (name, event, first, second) in TRIGGERS {
            let ids = [first, second]
                .into_iter()
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(
                "CREATE TRIGGER canonical_inventory_{name} AFTER {event} BEGIN UPDATE memory_canonical_inventory SET covered={COVERED} WHERE episode_id IN ({ids}); END;"
            ));
        }
        tx.execute_batch(&sql).map_err(db_error)?;
        tx.execute(
            "INSERT INTO memory_state(key,value) VALUES('canonical_inventory_format',?1)",
            [FORMAT],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub(in crate::cognition) fn canonical_inventory_state(
        &self,
    ) -> CognitionResult<Option<InventoryState>> {
        state(self.connection()?)
    }

    pub(in crate::cognition) fn canonical_inventory_referencing(
        &self,
        message_id: &str,
    ) -> CognitionResult<Vec<String>> {
        referencing(self.connection()?, message_id)
    }

    pub(in crate::cognition) fn write_canonical_inventory(
        &mut self,
        write: &InventoryWrite,
    ) -> CognitionResult<()> {
        let tx = self.connection_mut()?.transaction().map_err(db_error)?;
        if write.reset {
            tx.execute("DELETE FROM memory_canonical_inventory", [])
                .map_err(db_error)?;
        }
        for key in &write.deletes {
            tx.execute(
                "DELETE FROM memory_canonical_inventory WHERE source_key=?1",
                [key],
            )
            .map_err(db_error)?;
        }
        for candidate in &write.upserts {
            upsert(&tx, candidate)?;
        }
        save_state(&tx, &write.state)?;
        tx.commit().map_err(db_error)
    }
}

impl GraphRecallReader {
    pub(in crate::cognition) fn canonical_inventory_state(
        &self,
    ) -> CognitionResult<Option<InventoryState>> {
        state(self.connection()?)
    }

    pub(in crate::cognition) fn canonical_inventory_referencing(
        &self,
        message_id: &str,
    ) -> CognitionResult<Vec<String>> {
        referencing(self.connection()?, message_id)
    }

    /// The eligible rows whose episode revision is not completely projected.
    pub(in crate::cognition) fn uncovered_canonical_sources(
        &self,
    ) -> CognitionResult<Vec<InventoryCandidate>> {
        let db = self.connection()?;
        let mut statement = db
            .prepare(
                "SELECT kind,entity_id,session_id,request_message_id,assistant_message_id,episode_id,revision,created_at_json \
                 FROM memory_canonical_inventory WHERE eligible=1 AND covered=0",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    InventoryCandidate {
                        kind: CandidateKind::Turn,
                        id: row.get(1)?,
                        session_id: row.get(2)?,
                        request_message_id: row.get(3)?,
                        assistant_message_id: row.get(4)?,
                        eligible: Some(EligibleSource {
                            episode_id: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                            revision: row.get(6)?,
                            created_at: Vec::new(),
                        }),
                    },
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(db_error)?;
        let mut output = Vec::new();
        for row in rows {
            let (kind, mut candidate, created_at) = row.map_err(db_error)?;
            candidate.kind = kind_from(&kind)?;
            if let Some(eligible) = candidate.eligible.as_mut() {
                eligible.created_at = serde_json::from_str(&created_at).map_err(format_error)?;
            }
            output.push(candidate);
        }
        Ok(output)
    }
}

/// Whether `revision` of `episode_id` has a complete semantic projection.
const EPISODE_COMPLETE: &str = "SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j \
     ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
     WHERE c.memory_chunk_id=?1 AND c.current_revision=?2 \
       AND json_extract(j.semantic_graph_state,'$.state')='complete' LIMIT 1";

fn upsert(tx: &Transaction<'_>, candidate: &InventoryCandidate) -> CognitionResult<()> {
    let key = candidate.key();
    let eligible = candidate.eligible.as_ref();
    let created_at = serde_json::to_string(&eligible.map_or(&[][..], |e| &e.created_at[..]))
        .map_err(format_error)?;
    tx.execute(
        "INSERT INTO memory_canonical_inventory(source_key,kind,entity_id,session_id,request_message_id,assistant_message_id,eligible,episode_id,revision,created_at_json) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(source_key) DO UPDATE SET kind=excluded.kind,entity_id=excluded.entity_id,\
         session_id=excluded.session_id,request_message_id=excluded.request_message_id,assistant_message_id=excluded.assistant_message_id,\
         eligible=excluded.eligible,episode_id=excluded.episode_id,revision=excluded.revision,created_at_json=excluded.created_at_json",
        params![
            key,
            kind_name(candidate.kind),
            candidate.id,
            candidate.session_id,
            candidate.request_message_id,
            candidate.assistant_message_id,
            eligible.is_some(),
            eligible.map(|e| &e.episode_id),
            eligible.and_then(|e| e.revision.as_ref()),
            created_at,
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

fn referencing(db: &Connection, message_id: &str) -> CognitionResult<Vec<String>> {
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

/// The stored state; `None` before the first build of this [`FORMAT`].
fn state(db: &Connection) -> CognitionResult<Option<InventoryState>> {
    if read_key(db, "canonical_inventory_format")?.as_deref() != Some(FORMAT) {
        return Ok(None);
    }
    let (Some(identity), Some(seq), Some(phase)) = (
        read_key(db, "canonical_inventory_identity")?,
        read_key(db, "canonical_inventory_seq")?.and_then(|seq| seq.parse().ok()),
        read_key(db, "canonical_inventory_phase")?,
    ) else {
        return Ok(None);
    };
    let cursor = read_key(db, "canonical_inventory_cursor")?.filter(|cursor| !cursor.is_empty());
    let phase = match phase.as_str() {
        "outcomes" => InventoryPhase::Outcomes(cursor),
        "messages" => InventoryPhase::Messages(cursor),
        "ready" => InventoryPhase::Ready,
        _ => return Ok(None),
    };
    Ok(Some(InventoryState {
        identity,
        seq,
        phase,
    }))
}

fn save_state(tx: &Transaction<'_>, state: &InventoryState) -> CognitionResult<()> {
    let (phase, cursor) = match &state.phase {
        InventoryPhase::Outcomes(cursor) => ("outcomes", cursor.as_deref()),
        InventoryPhase::Messages(cursor) => ("messages", cursor.as_deref()),
        InventoryPhase::Ready => ("ready", None),
    };
    for (key, value) in [
        ("canonical_inventory_identity", state.identity.as_str()),
        ("canonical_inventory_seq", &state.seq.to_string()),
        ("canonical_inventory_phase", phase),
        ("canonical_inventory_cursor", cursor.unwrap_or_default()),
    ] {
        tx.execute(
            "INSERT INTO memory_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn read_key(db: &Connection, key: &str) -> CognitionResult<Option<String>> {
    db.query_row(
        "SELECT value FROM memory_state WHERE key=?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .optional()
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
        _ => Err(crate::cognition::CognitionError::new(
            crate::cognition::CognitionCode::MemoryGraphUnavailable,
            "canonical_inventory_kind_invalid",
        )),
    }
}

fn format_error(error: serde_json::Error) -> crate::cognition::CognitionError {
    crate::cognition::CognitionError::new(
        crate::cognition::CognitionCode::MemoryGraphUnavailable,
        error.to_string(),
    )
    .with_source(error)
}

impl GraphRecallReader {
    /// Whether `revision` of `episode_id` has a complete semantic projection.
    pub(in crate::cognition) fn episode_complete(
        &self,
        episode_id: &str,
        revision: &str,
    ) -> CognitionResult<bool> {
        Ok(self
            .connection()?
            .prepare_cached(EPISODE_COMPLETE)
            .map_err(db_error)?
            .query_row(params![episode_id, revision], |row| row.get::<_, i64>(0))
            .optional()
            .map_err(db_error)?
            .is_some())
    }
}
