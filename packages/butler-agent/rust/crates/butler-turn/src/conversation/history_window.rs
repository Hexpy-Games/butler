//! Read-only completion-ordered history. Discarded payloads are never hydrated.
use super::types::*;
use super::{AgentConversationStore, ConversationError, ConversationResult, summaries};
use rusqlite::Connection;
mod load;

pub struct HistoryWindow {
    pub material: PromptMaterial,
    pub digest: String,
    pub legacy_material: PromptMaterial,
    pub late_turn_ids: Vec<String>,
}

impl AgentConversationStore {
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
    let summaries = valid_summaries(db, session)?;
    let epoch = summaries
        .iter()
        .map(|s| s.covers_to_seq as u64)
        .max()
        .unwrap_or(0);
    let sizes = completed_sizes(db, session, epoch)?;
    let summary_bytes: usize = summaries.iter().map(|s| s.summary_text.len() + 128).sum();
    let start = window_start(&sizes, cap, summary_bytes + cap / 10);
    let ids: Vec<_> = sizes[start..].iter().map(|(id, _)| id.clone()).collect();
    let mut material = load::material(db, session, &ids, epoch)?;
    material.summaries = summaries;
    let late_turn_ids = late_ids(&material.turns);
    let digest = dropped_digest(db, &sizes[..start], epoch, cap / 10)?;
    let legacy_material = load::legacy_material(db, session, cap, &material.summaries)?;
    Ok(HistoryWindow {
        material,
        digest,
        late_turn_ids,
        legacy_material,
    })
}

fn late_ids(turns: &[ConversationTurn]) -> Vec<String> {
    turns
        .iter()
        .enumerate()
        .filter(|(index, turn)| turns[..*index].iter().any(|earlier| earlier.seq > turn.seq))
        .map(|(_, turn)| turn.id.clone())
        .collect()
}

fn window_start(sizes: &[(String, usize)], cap: usize, reserved: usize) -> usize {
    let mut start = 0;
    let mut used = reserved;
    for (end, (_, size)) in sizes.iter().enumerate() {
        used = used.saturating_add(*size);
        if used > cap && end + 1 - start > 4 {
            while used > cap * 3 / 5 && end + 1 - start > 4 {
                used = used.saturating_sub(sizes[start].1);
                start += 1;
            }
        }
    }
    start
}

fn completed_sizes(
    db: &Connection,
    session: &str,
    epoch: u64,
) -> ConversationResult<Vec<(String, usize)>> {
    // octet_length reads SQLite's stored size, without loading overflow pages.
    // Capsules and envelopes are charged alongside the condensed tool labels.
    let mut query = db.prepare(
        "SELECT t.id,768+s.bytes+ \
         COALESCE((SELECT octet_length(evidence_refs_json)+octet_length(unresolved_obligations_json)+ \
         COALESCE(octet_length(continuation_json),0)+512 FROM conversation_turn_outcomes o WHERE o.turn_id=t.id),0) \
         FROM (SELECT m.turn_id,SUM(CASE WHEN p.kind IN ('tool_call','tool_result') \
         THEN 160 ELSE octet_length(p.content_json)+64 END) bytes \
         FROM conversation_messages m JOIN conversation_parts p ON p.message_id=m.id \
         WHERE m.session_id=?1 AND m.seq>?2 GROUP BY m.turn_id) s \
         JOIN conversation_turns t ON t.id=s.turn_id \
         WHERE t.completed_at IS NOT NULL ORDER BY t.completed_at,t.seq"
    ).map_err(ConversationError::sqlite)?;
    query
        .query_map(rusqlite::params![session, epoch], |r| {
            Ok((r.get(0)?, r.get(1)?))
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
    dropped: &[(String, usize)],
    epoch: u64,
    cap: usize,
) -> ConversationResult<String> {
    let mut lines = Vec::new();
    let mut used = 0;
    // Only the newest digest entries can fit; do not inspect the rest of the range.
    let mut query = db.prepare("SELECT substr(json_extract(p.content_json,'$.text'),1,160) \
        FROM conversation_messages m JOIN conversation_parts p ON p.message_id=m.id \
        WHERE m.turn_id=?1 AND m.seq>?2 AND m.role='user' AND p.kind='text' ORDER BY m.seq,p.part_index LIMIT 1")
        .map_err(ConversationError::sqlite)?;
    for (id, _) in dropped.iter().rev() {
        use rusqlite::OptionalExtension;
        let request: Option<String> = query
            .query_row(rusqlite::params![id, epoch], |r| r.get(0))
            .optional()
            .map_err(ConversationError::sqlite)?
            .flatten();
        let text = request.unwrap_or_default().replace(['\n', '\r'], " ");
        let mut end = text.len().min(160);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let line = format!("dropped turn {id}: {}", &text[..end]);
        if used + line.len() + 1 > cap {
            break;
        }
        used += line.len() + 1;
        lines.push(line);
    }
    lines.reverse();
    Ok(lines.join("\n"))
}
