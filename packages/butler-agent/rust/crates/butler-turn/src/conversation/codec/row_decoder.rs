//! Resolve SQLite columns once for a batch, preserving the canonical decoder.
use super::*;

pub(in crate::conversation) struct MessageColumns {
    id: usize,
    session_id: usize,
    turn_id: usize,
    seq: usize,
    role: usize,
    status: usize,
    visibility: usize,
    provenance: usize,
    created_at: usize,
    compacted_by_summary_id: usize,
    source_gateway: usize,
    source_ref: usize,
    origin_kind: usize,
    origin_ref: usize,
    origin_reason: usize,
    origin_version: usize,
    origin_evidence_json: usize,
}

impl MessageColumns {
    pub(in crate::conversation) fn new(
        statement: &rusqlite::Statement<'_>,
    ) -> rusqlite::Result<Self> {
        Ok(Self {
            id: statement.column_index("id")?,
            session_id: statement.column_index("session_id")?,
            turn_id: statement.column_index("turn_id")?,
            seq: statement.column_index("seq")?,
            role: statement.column_index("role")?,
            status: statement.column_index("status")?,
            visibility: statement.column_index("visibility")?,
            provenance: statement.column_index("provenance")?,
            created_at: statement.column_index("created_at")?,
            compacted_by_summary_id: statement.column_index("compacted_by_summary_id")?,
            source_gateway: statement.column_index("source_gateway")?,
            source_ref: statement.column_index("source_ref")?,
            origin_kind: statement.column_index("origin_kind")?,
            origin_ref: statement.column_index("origin_ref")?,
            origin_reason: statement.column_index("origin_reason")?,
            origin_version: statement.column_index("origin_version")?,
            origin_evidence_json: statement.column_index("origin_evidence_json")?,
        })
    }
}

pub(in crate::conversation) fn message_row_cached(
    row: &Row<'_>,
    columns: &MessageColumns,
) -> rusqlite::Result<ConversationMessage> {
    Ok(ConversationMessage {
        id: row.get(columns.id)?,
        session_id: row.get(columns.session_id)?,
        turn_id: row.get(columns.turn_id)?,
        seq: row.get(columns.seq)?,
        role: role(&row.get::<_, String>(columns.role)?).map_err(sql_conversion)?,
        status: status(&row.get::<_, String>(columns.status)?).map_err(sql_conversion)?,
        visibility: visibility(&row.get::<_, String>(columns.visibility)?)
            .map_err(sql_conversion)?,
        provenance: provenance(&row.get::<_, String>(columns.provenance)?)
            .map_err(sql_conversion)?,
        created_at: row.get(columns.created_at)?,
        compacted_by_summary_id: row.get(columns.compacted_by_summary_id)?,
        source_gateway: row.get(columns.source_gateway)?,
        source_ref: row.get(columns.source_ref)?,
        origin_kind: origin(&row.get::<_, String>(columns.origin_kind)?).map_err(sql_conversion)?,
        origin_ref: row.get(columns.origin_ref)?,
        origin_reason: row.get(columns.origin_reason)?,
        origin_version: row.get(columns.origin_version)?,
        origin_evidence_json: row.get(columns.origin_evidence_json)?,
    })
}
