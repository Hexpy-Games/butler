//! Read-only completion-ordered history. Discarded payloads are never hydrated.
use super::types::*;
use super::{AgentConversationStore, ConversationError, ConversationResult, summaries};
use rusqlite::Connection;
mod budget;
mod load;

pub struct HistoryWindow {
    pub material: PromptMaterial,
    pub digest: String,
    pub late_turn_ids: Vec<String>,
}

impl AgentConversationStore {
    /// Diagnostic budget geometry is opt-in; admission never reads it twice.
    #[cfg(feature = "test-support")]
    pub async fn read_history_budget_material(
        &self,
        session: &str,
        cap: usize,
    ) -> ConversationResult<PromptMaterial> {
        let session = session.to_owned();
        self.execute(move |db| {
            budget::register(db)?;
            let summaries = valid_summaries(db, &session)?;
            load::budget_material(db, &session, cap, &summaries)
        })
        .await
    }

    pub async fn read_history_window(
        &self,
        session: &str,
        cap: usize,
    ) -> ConversationResult<HistoryWindow> {
        let session = session.to_owned();
        self.execute(move |db| {
            let before = db.total_changes();
            #[cfg(feature = "test-support")]
            let window = super::db_load::measure(db, "history", |db| read(db, &session, cap))?;
            #[cfg(not(feature = "test-support"))]
            let window = read(db, &session, cap)?;
            if std::env::var("BUTLER_E2E_VERIFY_HISTORY_WRITES").as_deref() == Ok("1") {
                eprintln!(
                    "[history-projection-writes] changes={}",
                    db.total_changes() - before
                );
            }
            Ok(window)
        })
        .await
    }
}

pub(super) fn read(
    db: &Connection,
    session: &str,
    cap: usize,
) -> ConversationResult<HistoryWindow> {
    budget::register(db)?;
    let summaries = valid_summaries(db, session)?;
    let epoch = summaries
        .iter()
        .map(|s| s.covers_to_seq)
        .fold(0.0_f64, f64::max);
    let sizes = completed_sizes(db, session, epoch)?;
    let summary_bytes: usize = summaries.iter().map(|s| s.summary_text.len() + 128).sum();
    let start = window_start(&sizes, cap, summary_bytes + cap / 10);
    let ids: Vec<_> = sizes
        .iter()
        .skip(start)
        .map(|(id, _, _)| id.clone())
        .collect();
    let mut material = load::material(db, session, &ids, epoch)?;
    material.summaries = summaries;
    let late_turn_ids = late_ids(&material.turns);
    let digest = dropped_digest(
        db,
        session,
        sizes.get(..start).unwrap_or_default(),
        cap / 10,
    )?;
    Ok(HistoryWindow {
        material,
        digest,
        late_turn_ids,
    })
}

fn late_ids(turns: &[ConversationTurn]) -> Vec<String> {
    turns
        .iter()
        .enumerate()
        .filter(|(index, turn)| {
            turns
                .iter()
                .take(*index)
                .any(|earlier| earlier.seq > turn.seq)
        })
        .map(|(_, turn)| turn.id.clone())
        .collect()
}

fn window_start(sizes: &[(String, usize, Option<f64>)], cap: usize, reserved: usize) -> usize {
    let mut start = 0;
    let mut used = reserved;
    for (end, (_, size, _)) in sizes.iter().enumerate() {
        used = used.saturating_add(*size);
        if used > cap && end + 1 - start > 4 {
            while used > cap * 3 / 5 && end + 1 - start > 4 {
                let Some((_, size, _)) = sizes.get(start) else {
                    break;
                };
                used = used.saturating_sub(*size);
                start += 1;
            }
        }
    }
    start
}

fn completed_sizes(
    db: &Connection,
    session: &str,
    epoch: f64,
) -> ConversationResult<Vec<(String, usize, Option<f64>)>> {
    // octet_length reads SQLite's stored size, without loading overflow pages.
    // Capsules and envelopes are charged alongside the condensed tool labels.
    let mut query = db.prepare(
        "SELECT t.id,768+s.bytes+ \
         COALESCE((SELECT octet_length(evidence_refs_json)+octet_length(unresolved_obligations_json)+ \
         COALESCE(octet_length(continuation_json),0)+512 FROM conversation_turn_outcomes o WHERE o.turn_id=t.id),0),s.request_seq \
         FROM (SELECT m.turn_id,SUM(CASE WHEN p.kind IN ('tool_call','tool_result') \
         THEN 160 ELSE octet_length(p.content_json)+64 END) bytes,MIN(CASE WHEN m.role='user' AND p.kind='text' THEN m.seq END) request_seq, \
         MIN(CASE WHEN m.role='assistant' AND m.status IN ('complete','compacted') THEN m.seq END) terminal_seq \
         FROM conversation_messages m INDEXED BY conversation_messages_session_seq_idx \
         JOIN conversation_parts p ON p.message_id=m.id \
         WHERE m.session_id=?1 AND m.seq>?2 \
         AND EXISTS (SELECT 1 FROM conversation_turns completed WHERE completed.id=m.turn_id \
         AND completed.completed_at IS NOT NULL) GROUP BY m.turn_id) s \
         JOIN conversation_turns t ON t.id=s.turn_id \
         LEFT JOIN conversation_turn_outcomes o ON o.turn_id=t.id \
         LEFT JOIN conversation_messages final ON final.id=o.public_assistant_message_id \
         WHERE t.completed_at IS NOT NULL ORDER BY COALESCE(final.seq,s.terminal_seq,s.request_seq,t.seq),t.seq"
    ).map_err(ConversationError::sqlite)?;
    query
        .query_map(rusqlite::params![session, epoch], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(ConversationError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(ConversationError::sqlite)
}

fn valid_summaries(db: &Connection, session: &str) -> ConversationResult<Vec<ConversationSummary>> {
    // Same stale-source predicate as invalidate_stale, without its writes.
    let mut valid = Vec::new();
    for summary in summaries::query_summaries(db, session)? {
        if summaries::range_hash(db, session, summary.covers_from_seq, summary.covers_to_seq)?
            == summary.source_hash
        {
            valid.push(summary);
        }
    }
    Ok(valid)
}

fn dropped_digest(
    db: &Connection,
    session: &str,
    dropped: &[(String, usize, Option<f64>)],
    cap: usize,
) -> ConversationResult<String> {
    let mut lines = Vec::new();
    let mut used = 0;
    // Only the newest digest entries can fit; do not inspect the rest of the range.
    let mut query = db.prepare("SELECT substr(json_extract(p.content_json,'$.text'),1,160) \
        FROM conversation_messages m INDEXED BY conversation_messages_session_seq_idx \
         JOIN conversation_parts p ON p.message_id=m.id \
        WHERE m.session_id=?1 AND m.seq=?2 AND m.role='user' AND p.kind='text' ORDER BY p.part_index LIMIT 1")
        .map_err(ConversationError::sqlite)?;
    for (id, _, request_seq) in dropped.iter().rev() {
        use rusqlite::OptionalExtension;
        let request: Option<String> = if let Some(seq) = request_seq {
            query
                .query_row(rusqlite::params![session, seq], |r| r.get(0))
                .optional()
                .map_err(ConversationError::sqlite)?
                .flatten()
        } else {
            None
        };
        let text = request.unwrap_or_default().replace(['\n', '\r'], " ");
        let mut end = text.len().min(160);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let line = format!("dropped turn {id}: {}", &text[..end]);
        let bytes = serde_json::to_string(&line)
            .map_err(ConversationError::json)?
            .len()
            + 1;
        if used + bytes > cap {
            break;
        }
        used += bytes;
        lines.push(line);
    }
    lines.reverse();
    Ok(lines.join("\n"))
}
