use super::super::{codec, turn_outcome, turns};
use super::*;
use rusqlite::Connection;

pub(super) fn material(
    db: &Connection,
    session: &str,
    ids: &[String],
    epoch: f64,
) -> ConversationResult<PromptMaterial> {
    let ids = serde_json::to_string(ids).map_err(ConversationError::json)?;
    let (turns, outcomes) = metadata(db, &ids)?;
    let mut by_turn = messages(db, session, &ids, epoch, None)?;
    let semantic_tail = turns
        .iter()
        .flat_map(|t| by_turn.remove(&t.id).unwrap_or_default())
        .collect();
    Ok(PromptMaterial {
        session_id: session.into(),
        summaries: vec![],
        semantic_tail,
        current_turn: vec![],
        turns,
        outcomes,
        token_estimate: 0,
        provenance: vec![],
    })
}

fn metadata(
    db: &Connection,
    ids: &str,
) -> ConversationResult<(Vec<ConversationTurn>, Vec<TurnOutcomeCapsule>)> {
    let mut query = db.prepare("SELECT COALESCE(t.first_completed_at,t.completed_at) AS completed_at,t.*, \
        o.id AS outcome_id,o.session_id AS outcome_session_id,o.turn_id AS outcome_turn_id, \
        o.generation AS outcome_generation,o.outcome AS outcome_outcome,o.source_hash AS outcome_source_hash, \
        o.request_message_id AS outcome_request_message_id,o.public_assistant_message_id AS outcome_public_assistant_message_id, \
        o.provider_id AS outcome_provider_id,o.model_ref AS outcome_model_ref,o.evidence_refs_json AS outcome_evidence_refs_json, \
        o.unresolved_obligations_json AS outcome_unresolved_obligations_json,o.continuation_json AS outcome_continuation_json, \
        o.safe_code AS outcome_safe_code,o.created_at AS outcome_created_at \
        FROM json_each(?1) j JOIN conversation_turns t ON t.id=j.value \
        LEFT JOIN conversation_turn_outcomes o ON o.turn_id=t.id ORDER BY j.key").map_err(ConversationError::sqlite)?;
    let mut rows = query.query([ids]).map_err(ConversationError::sqlite)?;
    let (mut turns, mut outcomes) = (Vec::new(), Vec::new());
    while let Some(row) = rows.next().map_err(ConversationError::sqlite)? {
        turns.push(turns::turn_row(row).map_err(ConversationError::sqlite)?);
        if row
            .get::<_, Option<String>>("outcome_id")
            .map_err(ConversationError::sqlite)?
            .is_some()
        {
            outcomes.push(turn_outcome::history_outcome_row(row, "outcome_")?);
        }
    }
    Ok((turns, outcomes))
}

fn messages(
    db: &Connection,
    session: &str,
    ids: &str,
    epoch: f64,
    selected_messages: Option<&str>,
) -> ConversationResult<std::collections::HashMap<String, Vec<ConversationMessageWithParts>>> {
    let mut query = db.prepare(
        "SELECT m.*,p.id AS part_id,p.message_id,p.part_index,p.kind, \
         CASE p.kind WHEN 'tool_call' THEN json_object('safeToolName',COALESCE(json_extract(p.content_json,'$.safeToolName'),json_extract(p.content_json,'$.toolName'),json_extract(p.content_json,'$.name'),'tool')) \
         WHEN 'tool_result' THEN json_object('safeLabel',COALESCE(json_extract(p.content_json,'$.safeLabel'),json_extract(p.content_json,'$.status'), \
         CASE WHEN json_extract(p.content_json,'$.ok')=0 THEN 'failed' ELSE 'complete' END)) ELSE p.content_json END, \
         p.tool_call_id,p.parent_tool_call_id,p.provider_shape,p.status AS part_status \
         FROM conversation_messages m INDEXED BY conversation_messages_session_seq_idx CROSS JOIN json_each(?1) j \
         JOIN conversation_parts p ON p.message_id=m.id WHERE m.session_id=?3 AND (m.turn_id=j.value OR (m.turn_id IS NULL AND m.id=j.value)) AND m.seq>?2 \
         AND (?4 IS NULL OR m.id IN (SELECT value FROM json_each(?4))) ORDER BY j.key,m.seq,p.part_index"
    ).map_err(ConversationError::sqlite)?;
    let offset = query.column_count() - 9;
    let columns = codec::MessageColumns::new(&query).map_err(ConversationError::sqlite)?;
    let mut rows = query
        .query(rusqlite::params![ids, epoch, session, selected_messages])
        .map_err(ConversationError::sqlite)?;
    let mut turns = std::collections::HashMap::new();
    let mut current: Option<ConversationMessageWithParts> = None;
    while let Some(row) = rows.next().map_err(ConversationError::sqlite)? {
        let id: String = row.get(0).map_err(ConversationError::sqlite)?;
        if current.as_ref().is_none_or(|m| m.message.id != id) {
            push(&mut turns, current.take());
            let mut message =
                codec::message_row_cached(row, &columns).map_err(ConversationError::sqlite)?;
            // A stale summary's messages are restored only in this read projection.
            if message.status == ConversationStatus::Compacted {
                message.status = ConversationStatus::Complete;
            }
            current = Some(ConversationMessageWithParts {
                message,
                parts: vec![],
            });
        }
        if let Some(current) = &mut current {
            current.parts.push(codec::decode_part(
                codec::part_row_at(row, offset).map_err(ConversationError::sqlite)?,
            )?);
        }
    }
    push(&mut turns, current);
    Ok(turns)
}

fn push(
    turns: &mut std::collections::HashMap<String, Vec<ConversationMessageWithParts>>,
    message: Option<ConversationMessageWithParts>,
) {
    if let Some(message) = message {
        let turn = message
            .message
            .turn_id
            .clone()
            .unwrap_or_else(|| message.message.id.clone());
        turns.entry(turn).or_default().push(message);
    }
}

pub(super) fn legacy_material(
    db: &Connection,
    session: &str,
    cap: usize,
    summaries: &[ConversationSummary],
) -> ConversationResult<PromptMaterial> {
    let limit = cap.div_ceil(80).clamp(20, 200);
    let valid = serde_json::to_string(&summaries.iter().map(|s| &s.id).collect::<Vec<_>>())
        .map_err(ConversationError::json)?;
    let mut query = db.prepare("SELECT id,turn_id FROM conversation_messages WHERE session_id=?1 \
        AND (compacted_by_summary_id IS NULL OR compacted_by_summary_id NOT IN (SELECT value FROM json_each(?2))) \
        ORDER BY seq DESC LIMIT ?3").map_err(ConversationError::sqlite)?;
    let pairs = query
        .query_map(rusqlite::params![session, valid, limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(ConversationError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ConversationError::sqlite)?;
    let message_ids: std::collections::HashSet<_> =
        pairs.iter().map(|(id, _)| id.as_str()).collect();
    let ids: Vec<_> = pairs
        .iter()
        .rev()
        .map(|(message, id)| id.clone().unwrap_or_else(|| message.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let selected = serde_json::to_string(&pairs.iter().map(|(id, _)| id).collect::<Vec<_>>())
        .map_err(ConversationError::json)?;
    let ids = serde_json::to_string(&ids).map_err(ConversationError::json)?;
    let (turns, outcomes) = metadata(db, &ids)?;
    let semantic_tail = messages(db, session, &ids, 0.0, Some(&selected))?
        .into_values()
        .flatten()
        .collect();
    let mut material = PromptMaterial {
        session_id: session.into(),
        summaries: vec![],
        semantic_tail,
        current_turn: vec![],
        turns,
        outcomes,
        token_estimate: 0,
        provenance: vec![],
    };
    material
        .semantic_tail
        .retain(|m| message_ids.contains(m.message.id.as_str()));
    material.semantic_tail.sort_by_key(|m| m.message.seq);
    material.summaries = summaries.to_vec();
    Ok(material)
}
