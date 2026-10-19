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
//! store identity and the change log position they reflect.

mod rows;

use butler_turn::conversation::SourceChangeMark;
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::{GraphRecallReader, GraphRepository, db_error};
use crate::cognition::CognitionResult;
use crate::cognition::sources::InventoryCandidate;
pub(in crate::cognition) use rows::Uncovered;

/// Row derivation and schema version; a change rebuilds the rows.
const FORMAT: &str = "3";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS memory_canonical_inventory(source_key TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,session_id TEXT NOT NULL,request_message_id TEXT,assistant_message_id TEXT,eligible INTEGER NOT NULL,episode_id TEXT,revision TEXT,created_at_json TEXT NOT NULL,fault TEXT,fault_scope TEXT,covered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_episode ON memory_canonical_inventory(episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_request ON memory_canonical_inventory(request_message_id) WHERE request_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_answer ON memory_canonical_inventory(assistant_message_id) WHERE assistant_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_uncovered ON memory_canonical_inventory(session_id,source_key) WHERE eligible=1 AND covered=0;
CREATE INDEX IF NOT EXISTS idx_canonical_inventory_unreadable ON memory_canonical_inventory(session_id,source_key) WHERE eligible=1 AND covered=0 AND revision IS NULL;
";

/// Whether the row's episode revision is completely projected; recall's
/// per-entry coverage test.
const COVERED: &str = "EXISTS(SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE c.memory_chunk_id=memory_canonical_inventory.episode_id AND c.current_revision=memory_canonical_inventory.revision AND CASE WHEN json_valid(j.semantic_graph_state) THEN json_extract(j.semantic_graph_state,'$.state') END='complete')";

/// The coverage triggers: name, event, and the episode ids a write touches.
const TRIGGERS: [(&str, &str, &str); 6] = [
    (
        "chunk_insert",
        "INSERT ON memory_chunks",
        "NEW.memory_chunk_id",
    ),
    (
        "chunk_update",
        "UPDATE OF memory_chunk_id,current_revision ON memory_chunks",
        "OLD.memory_chunk_id,NEW.memory_chunk_id",
    ),
    (
        "chunk_delete",
        "DELETE ON memory_chunks",
        "OLD.memory_chunk_id",
    ),
    (
        "job_insert",
        "INSERT ON memory_projection_jobs",
        "NEW.episode_id",
    ),
    (
        "job_update",
        "UPDATE OF episode_id,revision,semantic_graph_state ON memory_projection_jobs",
        "OLD.episode_id,NEW.episode_id",
    ),
    (
        "job_delete",
        "DELETE ON memory_projection_jobs",
        "OLD.episode_id",
    ),
];

/// Where the mirrored inventory stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct InventoryState {
    /// The canonical store the rows describe.
    pub identity: String,
    /// Every change up to this log position is reflected in the rows;
    /// during the initial build, the position at which it began.
    pub mark: SourceChangeMark,
    /// The log head read after the rows' sources were last read: no row
    /// reflects a change past it, so the store must still hold it.
    pub seen: SourceChangeMark,
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
    /// Creates the inventory table and its coverage triggers. Another
    /// [`FORMAT`] drops the old rows and state first; a missing trigger is
    /// recreated and every row's `covered` flag recomputed.
    pub(in crate::cognition) fn install_canonical_inventory(&mut self) -> CognitionResult<()> {
        let db = self.connection_mut()?;
        let current = read_key(db, "canonical_inventory_format")?.as_deref() == Some(FORMAT);
        if current && installed(db)? {
            return Ok(());
        }
        let tx = db.transaction().map_err(db_error)?;
        let mut sql = String::new();
        if !current {
            sql.push_str("DROP TABLE IF EXISTS memory_canonical_inventory;");
            sql.push_str("DELETE FROM memory_state WHERE key LIKE 'canonical_inventory_%';");
        }
        sql.push_str(SCHEMA);
        for (name, event, ids) in TRIGGERS {
            sql.push_str(&format!(
                "DROP TRIGGER IF EXISTS canonical_inventory_{name}; CREATE TRIGGER canonical_inventory_{name} AFTER {event} BEGIN UPDATE memory_canonical_inventory SET covered={COVERED} WHERE episode_id IN ({ids}); END;"
            ));
        }
        sql.push_str(&format!(
            "UPDATE memory_canonical_inventory SET covered={COVERED};"
        ));
        tx.execute_batch(&sql).map_err(db_error)?;
        tx.execute(
            "INSERT INTO memory_state(key,value) VALUES('canonical_inventory_format',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
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
        rows::referencing(self.connection()?, message_id)
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
            rows::upsert(&tx, candidate)?;
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
        rows::referencing(self.connection()?, message_id)
    }

    /// Streams the eligible rows whose episode revision is not completely
    /// projected (only the sessions in `sessions` when given; only the rows
    /// without a revision when `unreadable_only`) until `visit` says stop.
    pub(in crate::cognition) fn visit_uncovered_canonical_sources(
        &self,
        uncovered: &Uncovered<'_>,
        visit: impl FnMut(InventoryCandidate) -> CognitionResult<bool>,
    ) -> CognitionResult<()> {
        rows::visit_uncovered(self.connection()?, uncovered, visit)
    }

    /// Whether `revision` of `episode_id` has a complete semantic projection.
    pub(in crate::cognition) fn episode_complete(
        &self,
        episode_id: &str,
        revision: &str,
    ) -> CognitionResult<bool> {
        rows::episode_complete(self.connection()?, episode_id, revision)
    }
}

/// Whether the table and every coverage trigger exist.
fn installed(db: &Connection) -> CognitionResult<bool> {
    let names = TRIGGERS
        .iter()
        .map(|(name, ..)| format!("'canonical_inventory_{name}'"))
        .collect::<Vec<_>>()
        .join(",");
    let found: i64 = db
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM sqlite_master WHERE (type='trigger' AND name IN ({names})) OR (type='table' AND name='memory_canonical_inventory')"
            ),
            [],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    Ok(found == i64::try_from(TRIGGERS.len() + 1).unwrap_or(i64::MAX))
}

/// The stored state; `None` before the first build of this [`FORMAT`] or
/// while a coverage trigger is missing.
fn state(db: &Connection) -> CognitionResult<Option<InventoryState>> {
    if read_key(db, "canonical_inventory_format")?.as_deref() != Some(FORMAT) || !installed(db)? {
        return Ok(None);
    }
    let (Some(identity), Some(mark), Some(seen), Some(phase)) = (
        read_key(db, "canonical_inventory_identity")?,
        read_mark(db, "canonical_inventory_seq")?,
        read_mark(db, "canonical_inventory_seen")?,
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
        mark,
        seen,
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
        ("canonical_inventory_seq", &state.mark.seq.to_string()),
        ("canonical_inventory_seq_key", state.mark.key.as_str()),
        ("canonical_inventory_seen", &state.seen.seq.to_string()),
        ("canonical_inventory_seen_key", state.seen.key.as_str()),
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

/// A log position stored under `key` (its sequence) and `{key}_key`.
fn read_mark(db: &Connection, key: &str) -> CognitionResult<Option<SourceChangeMark>> {
    let seq = read_key(db, key)?.and_then(|seq| seq.parse().ok());
    let entry = read_key(db, &format!("{key}_key"))?;
    Ok(seq
        .zip(entry)
        .map(|(seq, key)| SourceChangeMark { seq, key }))
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
