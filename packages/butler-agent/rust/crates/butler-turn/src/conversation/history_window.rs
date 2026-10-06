//! Completion-ordered history, selected without hydrating discarded payloads.
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

use super::types::*;
use super::{AgentConversationStore, ConversationError, ConversationResult, codec, summaries};

/// The retained whole turns and messages awaiting existing summary coverage.
pub struct HistoryWindow {
    pub material: PromptMaterial,
    pub dropped: Vec<ConversationMessageWithParts>,
    pub late_turn_ids: Vec<String>,
    sizes: Vec<(String, usize)>,
}

impl HistoryWindow {
    /// Re-fold the same admitted snapshot after a canonical summary write.
    pub fn with_summaries(mut self, summaries: Vec<ConversationSummary>, cap: usize) -> Self {
        self.material.summaries = summaries;
        let bytes = self
            .material
            .summaries
            .iter()
            .map(|s| s.summary_text.len() + 128)
            .sum();
        let start = window_start(&self.sizes, cap, bytes);
        let dropped: HashSet<_> = self.sizes.drain(..start).map(|(id, _)| id).collect();
        self.material
            .turns
            .retain(|turn| !dropped.contains(&turn.id));
        self.material
            .outcomes
            .retain(|outcome| !dropped.contains(&outcome.turn_id));
        let (removed, kept) = self
            .material
            .semantic_tail
            .into_iter()
            .partition(|message| {
                message
                    .message
                    .turn_id
                    .as_ref()
                    .is_some_and(|id| dropped.contains(id))
            });
        self.material.semantic_tail = kept;
        self.dropped = removed;
        self.dropped.sort_by_key(|message| message.message.seq);
        self
    }
}

impl AgentConversationStore {
    /// Refreshes only the bounded summary projection after a window move.
    pub async fn read_history_summaries(
        &self,
        session: &str,
        cap: usize,
    ) -> ConversationResult<Vec<ConversationSummary>> {
        let session = session.to_owned();
        self.execute(move |db| recent_summaries(db, &session, cap))
            .await
    }

    /// Folds completed turn sizes since the existing summary epoch. No window state is stored.
    pub async fn read_history_window(
        &self,
        session: &str,
        cap: usize,
    ) -> ConversationResult<HistoryWindow> {
        let session = session.to_owned();
        self.execute(move |db| read(db, &session, cap)).await
    }
}

fn read(db: &Connection, session: &str, cap: usize) -> ConversationResult<HistoryWindow> {
    let started = std::time::Instant::now();
    let sizes = completed_sizes(db, session)?;
    let sized = started.elapsed();
    let summaries = recent_summaries(db, session, cap)?;
    let summary_bytes = summaries
        .iter()
        .map(|summary| summary.summary_text.len() + 128)
        .sum();
    let start = window_start(&sizes, cap, summary_bytes);
    let mut material = PromptMaterial {
        session_id: session.to_owned(),
        summaries,
        semantic_tail: vec![],
        current_turn: vec![],
        turns: vec![],
        outcomes: vec![],
        token_estimate: 0,
        provenance: vec![],
    };
    let mut dropped = Vec::new();
    let mut messages_by_turn = completed_messages(db, session)?;
    let hydrated = started.elapsed();
    for (index, (id, _)) in sizes.iter().enumerate() {
        let messages = messages_by_turn.remove(id).unwrap_or_default();
        if index < start {
            dropped.extend(messages);
            continue;
        }
        material.semantic_tail.extend(messages);
        if let Some(turn) = super::turns::get_turn(db, id)? {
            material.turns.push(turn);
        }
        if let Some(outcome) = super::turn_outcome::read_outcome(db, id)? {
            material.outcomes.push(outcome);
        }
    }
    dropped.sort_by_key(|message| message.message.seq);
    let mut late_turn_ids = Vec::new();
    for turn in &material.turns {
        let late: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE session_id=?1 \
             AND seq>?2 AND completed_at<?3)",
                rusqlite::params![session, turn.seq, turn.completed_at],
                |row| row.get(0),
            )
            .map_err(ConversationError::sqlite)?;
        if late {
            late_turn_ids.push(turn.id.clone());
        }
    }
    if std::env::var("BUTLER_E2E_STARTUP_TRACE").as_deref() == Ok("1") {
        eprintln!(
            "[history-read] size_us={} hydrate_us={} metadata_us={}",
            sized.as_micros(),
            hydrated.saturating_sub(sized).as_micros(),
            started.elapsed().saturating_sub(hydrated).as_micros()
        );
    }
    Ok(HistoryWindow {
        material,
        dropped,
        late_turn_ids,
        sizes: sizes.into_iter().skip(start).collect(),
    })
}

fn window_start(sizes: &[(String, usize)], cap: usize, summary_bytes: usize) -> usize {
    let mut start = 0;
    let mut used: usize = summary_bytes;
    for (end, (_, size)) in sizes.iter().enumerate() {
        used = used.saturating_add(*size);
        if used > cap && end + 1 - start > 4 {
            while used > cap * 3 / 5 && end + 1 - start > 4 {
                let Some((_, size)) = sizes.get(start) else {
                    break;
                };
                used = used.saturating_sub(*size);
                start += 1;
            }
        }
    }
    start
}

fn completed_sizes(db: &Connection, session: &str) -> ConversationResult<Vec<(String, usize)>> {
    // Tool content is represented by fixed call/result labels, never charged as raw output.
    // Other parts retain their own content; the fixed allowance covers turn/message envelopes.
    let mut query = db
        .prepare(
            "SELECT t.id,768+s.bytes FROM ( \
         SELECT m.turn_id,SUM(CASE WHEN p.kind IN ('tool_call','tool_result') \
         THEN 160 ELSE octet_length(p.content_json)+64 END) bytes \
         FROM conversation_messages m INDEXED BY conversation_messages_session_turn_seq_idx \
         JOIN conversation_parts p INDEXED BY conversation_parts_message_size_idx ON p.message_id=m.id \
         WHERE m.session_id=?1 AND m.compacted_by_summary_id IS NULL AND m.status!='compacted' \
         GROUP BY m.turn_id) s CROSS JOIN conversation_turns t INDEXED BY conversation_turns_history_completion_idx \
         WHERE t.id=s.turn_id AND t.session_id=?1 AND t.completed_at IS NOT NULL ORDER BY t.completed_at,t.seq",
        )
        .map_err(ConversationError::sqlite)?;
    query
        .query_map([session], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(ConversationError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ConversationError::sqlite)
}

fn completed_messages(
    db: &Connection,
    session: &str,
) -> ConversationResult<HashMap<String, Vec<ConversationMessageWithParts>>> {
    let mut query = db.prepare(
        "SELECT m.*,p.id AS part_id,p.message_id,p.part_index,p.kind,p.content_json,\
         p.tool_call_id,p.parent_tool_call_id,p.provider_shape,p.status AS part_status \
         FROM conversation_messages m INDEXED BY conversation_messages_session_turn_seq_idx \
         JOIN conversation_turns t INDEXED BY conversation_turns_history_completion_idx ON t.id=m.turn_id JOIN conversation_parts p INDEXED BY conversation_parts_message_part_idx ON p.message_id=m.id \
         WHERE m.session_id=?1 AND t.completed_at IS NOT NULL AND m.compacted_by_summary_id IS NULL \
         AND m.status!='compacted' ORDER BY m.turn_id,m.seq,p.part_index"
    ).map_err(ConversationError::sqlite)?;
    let offset = query.column_count() - 9;
    let columns = codec::MessageColumns::new(&query).map_err(ConversationError::sqlite)?;
    let mut previous = String::new();
    let rows = query
        .query_map([session], |row| {
            let id: String = row.get(0)?;
            let message = if id == previous {
                None
            } else {
                previous = id;
                Some(codec::message_row_cached(row, &columns)?)
            };
            Ok((message, codec::part_row_at(row, offset)?))
        })
        .map_err(ConversationError::sqlite)?;
    let mut turns = HashMap::new();
    let mut current: Option<ConversationMessageWithParts> = None;
    for row in rows {
        let (message, part) = row.map_err(ConversationError::sqlite)?;
        if let Some(message) = message {
            push_message(&mut turns, current.take());
            current = Some(ConversationMessageWithParts {
                message,
                parts: vec![],
            });
        }
        if let Some(message) = &mut current {
            message.parts.push(codec::decode_part(part)?);
        }
    }
    push_message(&mut turns, current);
    Ok(turns)
}

fn push_message(
    turns: &mut HashMap<String, Vec<ConversationMessageWithParts>>,
    message: Option<ConversationMessageWithParts>,
) {
    if let Some(message) = message
        && let Some(turn) = message.message.turn_id.clone()
    {
        turns.entry(turn).or_default().push(message);
    }
}

fn recent_summaries(
    db: &Connection,
    session: &str,
    cap: usize,
) -> ConversationResult<Vec<ConversationSummary>> {
    let mut query = db.prepare("SELECT id, octet_length(summary_text)+128 FROM conversation_summaries WHERE session_id=?1 AND invalidated_at IS NULL ORDER BY covers_from_seq DESC,covers_to_seq DESC").map_err(ConversationError::sqlite)?;
    let rows = query
        .query_map([session], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
        })
        .map_err(ConversationError::sqlite)?;
    let mut used = 0;
    let mut summaries = Vec::new();
    for row in rows {
        let (id, size) = row.map_err(ConversationError::sqlite)?;
        if used + size > cap * 2 / 5 {
            break;
        }
        used += size;
        summaries.push(
            db.query_row(
                "SELECT * FROM conversation_summaries WHERE id=?1",
                [id],
                summaries::summary_row,
            )
            .map_err(ConversationError::sqlite)?,
        );
    }
    summaries.reverse();
    Ok(summaries)
}
