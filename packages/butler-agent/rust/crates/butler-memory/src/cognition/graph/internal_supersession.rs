//! Retire a public turn projection after its canonical request is classified as internal control.

use std::collections::HashSet;

use rusqlite::{Connection, params};

use super::{GraphRepository, db_error};
use crate::cognition::CognitionResult;

#[derive(Clone, Copy)]
pub(in crate::cognition) struct InternalSupersessionInput<'a> {
    pub episode_id: &'a str,
    pub internal_control_message_ids: &'a [&'a str],
}

impl GraphRepository {
    pub(in crate::cognition) fn supersede_internal_projection(
        &mut self,
        input: InternalSupersessionInput<'_>,
    ) -> CognitionResult<()> {
        supersede(self.connection_mut()?, input)
    }
}

fn supersede(
    connection: &mut Connection,
    input: InternalSupersessionInput<'_>,
) -> CognitionResult<()> {
    let transaction = connection.transaction().map_err(db_error)?;
    let mut changed = transaction
        .execute(
            "UPDATE memory_chunks SET status='superseded',origin_kind='internal_control' \
             WHERE memory_chunk_id=?1 AND status='active'",
            [input.episode_id],
        )
        .map_err(db_error)?;

    for message_id in input.internal_control_message_ids {
        changed += transaction
            .execute(
                "UPDATE memory_chunk_sources SET origin_kind='internal_control' \
                 WHERE episode_id=?1 AND conversation_message_id=?2 AND origin_kind!='internal_control'",
                params![input.episode_id, message_id],
            )
            .map_err(db_error)?;
    }

    let affected_claims = {
        let mut statement = transaction
            .prepare(
                "SELECT DISTINCT evidence.node_id FROM memory_evidence evidence \
                 JOIN memory_claims claim ON claim.node_id=evidence.node_id \
                 WHERE evidence.episode_id=?1 ORDER BY evidence.node_id",
            )
            .map_err(db_error)?;
        statement
            .query_map([input.episode_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    for node_id in affected_claims {
        let source_class = source_class(&transaction, &node_id)?;
        changed += transaction
            .execute(
                "UPDATE memory_claims SET source_class=?1 WHERE node_id=?2 AND source_class!=?1",
                params![source_class, node_id],
            )
            .map_err(db_error)?;
    }

    if changed > 0 {
        transaction
            .execute(
                "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
                [],
            )
            .map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

fn source_class(connection: &Connection, node_id: &str) -> CognitionResult<&'static str> {
    let mut statement = connection
        .prepare(
            "SELECT source.role,source.source_kind,source.origin_kind \
             FROM memory_evidence evidence \
             JOIN memory_chunk_sources source ON source.source_id=evidence.source_id \
             WHERE evidence.node_id=?1 ORDER BY source.source_id",
        )
        .map_err(db_error)?;
    let classes = statement
        .query_map([node_id], |row| {
            let role = row.get::<_, String>(0)?;
            let source_kind = row.get::<_, String>(1)?;
            let origin_kind = row.get::<_, String>(2)?;
            Ok(classify_source(&role, &source_kind, &origin_kind))
        })
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    Ok(if classes.len() > 1 {
        "mixed"
    } else {
        classes.into_iter().next().unwrap_or("unknown")
    })
}

fn classify_source(role: &str, source_kind: &str, origin_kind: &str) -> &'static str {
    if source_kind == "task_report" {
        "task_report"
    } else if source_kind == "explicit_record" {
        "explicit"
    } else if role == "user" && origin_kind == "user_input" {
        "user"
    } else if role == "assistant" && origin_kind == "assistant_public" {
        "assistant"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests;
