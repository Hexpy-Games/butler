//! Read-only completion-ordered history. Discarded payloads are never hydrated.
use super::types::*;
use super::{AgentConversationStore, ConversationError, ConversationResult, summaries};
use rusqlite::Connection;
mod budget;
mod continuity;
mod load;
mod visible;
pub use visible::VisibleHistory;
pub(super) type VisibleWindows =
    std::sync::Mutex<std::collections::HashMap<String, VisibleHistory>>;
pub use continuity::{ContinuityBatch, ContinuityTurn};

pub struct HistoryWindow {
    pub material: PromptMaterial,
    pub digest: String,
    pub late_turn_ids: Vec<String>,
    pub omitted_turns: usize,
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
            #[cfg(feature = "e2e-fixtures")]
            let before = db.total_changes();
            #[cfg(feature = "test-support")]
            let window = super::db_load::measure(db, "history", |db| read(db, &session, cap))?;
            #[cfg(not(feature = "test-support"))]
            let window = read(db, &session, cap)?;
            #[cfg(feature = "e2e-fixtures")]
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
    let epoch_turns = epoch_turns(db, session, epoch, &sizes)?;
    let summary_bytes: usize = summaries.iter().map(|s| s.summary_text.len() + 128).sum();
    let start = window_start(
        &sizes,
        cap,
        summary_bytes.div_ceil(3) + (cap / 20).min(1_000) + 64,
    );
    let ids: Vec<_> = sizes
        .iter()
        .skip(start)
        .map(|size| size.id.clone())
        .collect();
    let mut material = load::material(db, session, &ids, epoch)?;
    material.summaries = summaries;
    let late_turn_ids = late_ids(&material.turns);
    let digest = dropped_digest(
        db,
        session,
        sizes.get(..start).unwrap_or_default(),
        (cap / 20).min(1_000),
    )?;
    Ok(HistoryWindow {
        material,
        digest,
        late_turn_ids,
        omitted_turns: epoch_turns + start,
    })
}

fn epoch_turns(
    db: &Connection,
    session: &str,
    epoch: f64,
    remaining: &[CompletedSize],
) -> ConversationResult<usize> {
    if epoch <= 0.0 {
        return Ok(0);
    }
    let ids = serde_json::to_string(&remaining.iter().map(|s| &s.id).collect::<Vec<_>>())
        .map_err(ConversationError::json)?;
    // Count only completed, wholly omitted turns in the indexed summarized
    // prefix. A turn straddling an epoch remains in `remaining`.
    db.query_row("SELECT COUNT(DISTINCT m.turn_id) FROM conversation_messages m \
        INDEXED BY conversation_messages_session_seq_idx JOIN conversation_turns t ON t.id=m.turn_id \
        WHERE m.session_id=?1 AND m.seq<=?2 AND t.completed_at IS NOT NULL \
        AND m.turn_id NOT IN (SELECT value FROM json_each(?3))",rusqlite::params![session,epoch,ids],|r|r.get(0))
        .map_err(ConversationError::sqlite)
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

fn window_start(sizes: &[CompletedSize], cap: usize, reserved: usize) -> usize {
    let mut start = 0;
    let mut used = reserved;
    for (end, size) in sizes.iter().enumerate() {
        used = used.saturating_add(size.tokens);
        if used > cap && end + 1 - start > 4 {
            while used > cap * 3 / 5 && end + 1 - start > 4 {
                let Some(size) = sizes.get(start) else {
                    break;
                };
                used = used.saturating_sub(size.tokens);
                start += 1;
            }
        }
    }
    start
}

struct CompletedSize {
    id: String,
    tokens: usize,
    request_seq: Option<f64>,
    through_seq: u64,
}

fn completed_sizes(
    db: &Connection,
    session: &str,
    epoch: f64,
) -> ConversationResult<Vec<CompletedSize>> {
    // No message bodies cross this size-only query. UTF-8 excess approximates
    // wide characters; tool payloads cost only one condensed label per turn.
    // Header/outcome JSON are charged at their rendered character sizes.
    let mut query = db.prepare(
        "SELECT t.id,CAST(s.tokens+(14+length(t.id)+length(t.status))/3.8+ \
         CASE WHEN s.tools>0 THEN 10 ELSE 0 END+CASE WHEN o.id IS NULL THEN 0 ELSE (31+length(json_object( \
         'source_hash',o.source_hash,'request_message_id',o.request_message_id, \
         'public_assistant_message_id',o.public_assistant_message_id, \
         'evidence_refs',json(o.evidence_refs_json), \
         'unresolved_obligations',json(o.unresolved_obligations_json), \
         'continuation',json(o.continuation_json),'safe_code',o.safe_code)))/3.8 END+0.999999 AS INTEGER), \
         s.request_seq,s.through_seq \
         FROM (SELECT m.turn_id,SUM(CASE WHEN p.kind IN ('tool_call','tool_result') \
         THEN 0 ELSE (octet_length(p.content_json)-length(p.content_json))/2.0+ \
         (length(p.content_json)-(octet_length(p.content_json)-length(p.content_json))/2.0)/3.8 END) tokens, \
         SUM(p.kind IN ('tool_call','tool_result')) tools, \
         MIN(CASE WHEN m.role='user' AND p.kind='text' THEN m.seq END) request_seq,MAX(m.seq) through_seq, \
         MAX(CASE WHEN m.role='assistant' AND m.status IN ('complete','compacted') THEN m.seq END) terminal_seq \
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
            Ok(CompletedSize {
                id: r.get(0)?,
                tokens: r.get(1)?,
                request_seq: r.get(2)?,
                through_seq: r.get(3)?,
            })
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
    dropped: &[CompletedSize],
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
    for size in dropped.iter().rev() {
        let id = &size.id;
        let request_seq = size.request_seq;
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
        let chars = line.chars().count();
        let wide = (line.len() - chars) / 2;
        let bytes = butler_core::json::saturating_usize(
            (wide as f64 + chars.saturating_sub(wide) as f64 / 3.8).ceil(),
        ) + 1;
        if used + bytes > cap {
            break;
        }
        used += bytes;
        lines.push(line);
    }
    lines.reverse();
    Ok(lines.join("\n"))
}

/// Stable guidance when the visible window omits earlier completed turns.
pub fn omitted_history_notice(count: usize) -> String {
    format!(
        "Older turns omitted: {count} earlier turns of this chat are not shown below. Session Continuity summarizes them; read_conversation_context returns their exact text. Look things up there before asking the user about anything they may already have said."
    )
}
