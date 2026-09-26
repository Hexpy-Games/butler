use rusqlite::{Connection, params};

use super::codec::{
    SourceHasher, enqueue, hydrate_message, message_row, normalize_limit, stringify,
};
use super::messages::semantic_tail;
use super::turn_outcome::read_outcome;
use super::turns::get_turn;
use super::types::*;
use super::{
    AgentConversationStore, ConversationError, ConversationIdentityClock, ConversationResult,
};

impl AgentConversationStore {
    pub(crate) async fn write_summary(
        &self,
        input: ConversationSummaryInput,
    ) -> ConversationResult<ConversationSummary> {
        let clock = self.identity_clock().clone();
        let now = input.now.clone().unwrap_or_else(|| clock.now_iso());
        self.execute(move |connection| write(connection, clock.as_ref(), input, now))
            .await
    }
    pub(crate) async fn read_summaries(
        &self,
        session_id: &str,
    ) -> ConversationResult<Vec<ConversationSummary>> {
        let clock = self.identity_clock().clone();
        let session_id = session_id.to_owned();
        self.execute(move |connection| {
            invalidate_stale(connection, clock.as_ref(), &session_id)?;
            query_summaries(connection, &session_id)
        })
        .await
    }
    pub(crate) async fn read_prompt_material(
        &self,
        session_id: &str,
        tail_limit: Option<f64>,
    ) -> ConversationResult<PromptMaterial> {
        let clock = self.identity_clock().clone();
        let session_id = session_id.to_owned();
        self.execute(move |connection| {
            invalidate_stale(connection, clock.as_ref(), &session_id)?;
            let summaries = query_summaries(connection, &session_id)?;
            let tail = semantic_tail(
                connection,
                &session_id,
                tail_limit.map(|limit| normalize_limit(Some(limit), 20, 200)),
            )?;
            let mut turns = Vec::new();
            for message in &tail {
                if let Some(id) = &message.message.turn_id
                    && !turns.iter().any(|turn: &ConversationTurn| &turn.id == id)
                    && let Some(turn) = get_turn(connection, id)?
                {
                    turns.push(turn);
                }
            }
            let mut outcomes = Vec::new();
            for turn in &turns {
                if let Some(outcome) = read_outcome(connection, &turn.id)? {
                    outcomes.push(outcome);
                }
            }
            let token_estimate = estimate_tokens(&tail, &summaries)?;
            let provenance = summaries
                .iter()
                .map(|value| PromptProvenance {
                    kind: PromptProvenanceKind::Summary,
                    id: value.id.clone(),
                })
                .chain(tail.iter().map(|value| PromptProvenance {
                    kind: PromptProvenanceKind::Message,
                    id: value.message.id.clone(),
                }))
                .collect();
            Ok(PromptMaterial {
                session_id,
                summaries,
                semantic_tail: tail,
                current_turn: vec![],
                turns,
                outcomes,
                token_estimate,
                provenance,
            })
        })
        .await
    }
}

pub(in crate::conversation) fn read_status_context_stats(
    connection: &Connection,
    session_id: &str,
    semantic_tail_limit: u64,
) -> ConversationResult<ConversationStatusStats> {
    let (summaries, stale_summary_ids) = read_status_summary_stats(connection, session_id)?;
    let (messages, semantic_tail) = super::messages::status_message_facts(
        connection,
        session_id,
        semantic_tail_limit,
        &stale_summary_ids,
    )?;
    let mut part_chars = 0_u64;
    let mut item_count = summaries.summaries;
    for message in semantic_tail {
        for part in &message.parts {
            part_chars = part_chars
                .saturating_add(stringify(&part.content_json)?.encode_utf16().count() as u64);
            item_count = item_count.saturating_add(1);
        }
    }
    let prompt_token_estimate = summaries
        .summary_text_chars
        .saturating_add(part_chars)
        .saturating_add(item_count.saturating_sub(1))
        .div_ceil(4);
    Ok(ConversationStatusStats {
        messages,
        summaries,
        prompt_token_estimate,
    })
}

fn read_status_summary_stats(
    connection: &Connection,
    session_id: &str,
) -> ConversationResult<(ConversationSummaryStats, Vec<String>)> {
    let mut statement = connection
        .prepare(
            "SELECT id,session_id,covers_from_seq,covers_to_seq,source_hash,\
             length(summary_text) FROM conversation_summaries WHERE session_id=?1 \
             AND invalidated_at IS NULL ORDER BY covers_from_seq ASC,covers_to_seq ASC",
        )
        .map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u64>(5)?,
            ))
        })
        .map_err(ConversationError::sqlite)?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(ConversationError::sqlite)?;
    let mut stats = ConversationSummaryStats {
        summaries: 0,
        summary_text_chars: 0,
    };
    let mut stale_ids = Vec::new();
    for (id, session_id, from, to, expected_hash, text_chars) in rows {
        if range_hash(connection, &session_id, from, to)? == expected_hash {
            stats.summaries = stats.summaries.saturating_add(1);
            stats.summary_text_chars = stats.summary_text_chars.saturating_add(text_chars);
        } else {
            stale_ids.push(id);
        }
    }
    Ok((stats, stale_ids))
}

fn write(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
    input: ConversationSummaryInput,
    now: String,
) -> ConversationResult<ConversationSummary> {
    let summary = ConversationSummary {
        id: input.summary_id.unwrap_or_else(|| clock.id("csm")),
        session_id: input.session_id,
        covers_from_seq: input.covers_from_seq,
        covers_to_seq: input.covers_to_seq,
        source_hash: input.source_hash,
        model: input.model,
        summary_text: input.summary_text,
        created_at: now.clone(),
        invalidated_at: None,
    };
    let tx = connection
        .transaction()
        .map_err(ConversationError::sqlite)?;
    tx.execute("INSERT INTO conversation_summaries (id,session_id,covers_from_seq,covers_to_seq,source_hash,model,summary_text,created_at,invalidated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL)",params![summary.id,summary.session_id,summary.covers_from_seq,summary.covers_to_seq,summary.source_hash,summary.model,summary.summary_text,summary.created_at]).map_err(ConversationError::sqlite)?;
    tx.execute("UPDATE conversation_messages SET status='compacted',compacted_by_summary_id=?1 WHERE session_id=?2 AND seq BETWEEN ?3 AND ?4",params![summary.id,summary.session_id,summary.covers_from_seq,summary.covers_to_seq]).map_err(ConversationError::sqlite)?;
    enqueue(
        &tx,
        clock,
        &summary.session_id,
        summary.covers_to_seq,
        "conversation.summary_written",
        &summary.id,
        &now,
    )?;
    tx.commit().map_err(ConversationError::sqlite)?;
    Ok(summary)
}

pub(in crate::conversation) fn query_summaries(
    connection: &Connection,
    session_id: &str,
) -> ConversationResult<Vec<ConversationSummary>> {
    let mut statement=connection.prepare("SELECT * FROM conversation_summaries WHERE session_id=?1 AND invalidated_at IS NULL ORDER BY covers_from_seq ASC,covers_to_seq ASC").map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map([session_id], summary_row)
        .map_err(ConversationError::sqlite)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(ConversationError::sqlite)
}
fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationSummary> {
    Ok(ConversationSummary {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        covers_from_seq: row.get("covers_from_seq")?,
        covers_to_seq: row.get("covers_to_seq")?,
        source_hash: row.get("source_hash")?,
        model: row.get("model")?,
        summary_text: row.get("summary_text")?,
        created_at: row.get("created_at")?,
        invalidated_at: row.get("invalidated_at")?,
    })
}

pub(in crate::conversation) fn range_hash(
    connection: &Connection,
    session: &str,
    from: f64,
    to: f64,
) -> ConversationResult<String> {
    let mut statement=connection.prepare("SELECT * FROM conversation_messages WHERE session_id=?1 AND seq BETWEEN ?2 AND ?3 ORDER BY seq ASC").map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map(params![session, from, to], message_row)
        .map_err(ConversationError::sqlite)?;
    let mut source = SourceHasher::new();
    for row in rows {
        let message = hydrate_message(connection, row.map_err(ConversationError::sqlite)?)?;
        source.push(&message)?;
    }
    Ok(source.finish())
}
fn invalidate_stale(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
    session: &str,
) -> ConversationResult<()> {
    let summaries = query_summaries(connection, session)?;
    let mut stale = Vec::new();
    for summary in summaries {
        if range_hash(
            connection,
            &summary.session_id,
            summary.covers_from_seq,
            summary.covers_to_seq,
        )? != summary.source_hash
        {
            stale.push(summary);
        }
    }
    if stale.is_empty() {
        return Ok(());
    }
    let tx = connection
        .transaction()
        .map_err(ConversationError::sqlite)?;
    let now = clock.now_iso();
    for summary in stale {
        tx.execute(
            "UPDATE conversation_summaries SET invalidated_at=?1 WHERE id=?2",
            params![now, summary.id],
        )
        .map_err(ConversationError::sqlite)?;
        tx.execute("UPDATE conversation_messages SET status='complete',compacted_by_summary_id=NULL WHERE session_id=?1 AND compacted_by_summary_id=?2",params![summary.session_id,summary.id]).map_err(ConversationError::sqlite)?;
    }
    tx.commit().map_err(ConversationError::sqlite)
}
fn estimate_tokens(
    messages: &[ConversationMessageWithParts],
    summaries: &[ConversationSummary],
) -> ConversationResult<u64> {
    let summary_chars: u64 = summaries
        .iter()
        .map(|v| v.summary_text.encode_utf16().count() as u64)
        .sum();
    let mut part_chars = 0;
    let mut count = summaries.len() as u64;
    for message in messages {
        for part in &message.parts {
            part_chars += stringify(&part.content_json)?.encode_utf16().count() as u64;
            count += 1;
        }
    }
    Ok((summary_chars + part_chars + count.saturating_sub(1)).div_ceil(4))
}
