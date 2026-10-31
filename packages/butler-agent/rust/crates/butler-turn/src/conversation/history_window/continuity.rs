//! Indexed unfolded range selection for change-driven chat continuity.
use super::*;

pub struct ContinuityBatch {
    pub through_seq: u64,
    pub turns: Vec<ContinuityTurn>,
}

pub struct ContinuityTurn {
    pub number: u64,
    pub status: String,
    pub user: String,
    /// The turn's labelled hook output, empty without one.
    pub hook_context: String,
    pub answer: String,
    pub tools: Vec<String>,
}

impl AgentConversationStore {
    /// Reads only the unfolded message range; folded payloads are never revisited.
    pub async fn read_continuity_batch(
        &self,
        session: &str,
        through_seq: u64,
        cap: usize,
        visible: Option<&VisibleHistory>,
    ) -> ConversationResult<Option<ContinuityBatch>> {
        let session = session.to_owned();
        let visible = visible.cloned();
        self.execute(move |db| batch(db, &session, through_seq, cap, visible.as_ref()))
            .await
    }
}

fn batch(
    db: &Connection,
    session: &str,
    through: u64,
    cap: usize,
    visible: Option<&VisibleHistory>,
) -> ConversationResult<Option<ContinuityBatch>> {
    let sizes = completed_sizes(db, session, through as f64)?;
    let mut keep = sizes.len();
    let mut used = 0;
    for size in sizes.iter().rev() {
        if used + size.tokens > cap * 3 / 5 {
            break;
        }
        used += size.tokens;
        keep -= 1;
    }
    // The history window guarantees four whole recent turns.
    keep = keep.min(sizes.len().saturating_sub(4));
    let barrier = unfold_barrier(db, session, through, sizes.get(keep..).unwrap_or_default())?;
    let mut candidates: Vec<_> = sizes
        .iter()
        .take(keep)
        .filter(|size| (size.through_seq as f64) < barrier)
        .collect();
    candidates.sort_by(|a, b| {
        a.request_seq
            .partial_cmp(&b.request_seq)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let omitted = visible.map_or_else(
        || window_start(&sizes, cap, (cap / 20).min(1_000) + 64) > 0,
        |window| candidates.iter().any(|size| !window.contains(&size.id)),
    );
    if candidates.is_empty()
        || (candidates.iter().map(|s| s.tokens).sum::<usize>() < 8_000 && !omitted)
    {
        return Ok(None);
    }
    let mut selected = Vec::new();
    let mut tokens = 0;
    let mut next = through;
    for size in candidates {
        if !selected.is_empty() && tokens + size.tokens > 16_000 {
            break;
        }
        selected.push(size.id.clone());
        tokens += size.tokens;
        next = next.max(size.through_seq);
    }
    let material = load::material(db, session, &selected, through as f64)?;
    let turns = material
        .turns
        .iter()
        .map(|turn| project(turn, &material))
        .collect();
    Ok(Some(ContinuityBatch {
        through_seq: next,
        turns,
    }))
}

// A message watermark must not cross the user message of a retained or still
// running turn, even when completions arrive out of admission order.
fn unfold_barrier(
    db: &Connection,
    session: &str,
    through: u64,
    retained: &[CompletedSize],
) -> ConversationResult<f64> {
    let pending: Option<f64> = db.query_row(
        "SELECT MIN(m.seq) FROM conversation_messages m INDEXED BY conversation_messages_session_seq_idx \
         JOIN conversation_turns t ON t.id=m.turn_id WHERE m.session_id=?1 AND m.seq>?2 AND t.completed_at IS NULL",
        rusqlite::params![session,through], |r|r.get(0)).map_err(ConversationError::sqlite)?;
    Ok(retained
        .iter()
        .filter_map(|s| s.request_seq)
        .fold(pending.unwrap_or(f64::INFINITY), f64::min))
}

fn project(turn: &ConversationTurn, material: &PromptMaterial) -> ContinuityTurn {
    use super::super::{ToolParts, text_for_message};
    let messages: Vec<_> = material
        .semantic_tail
        .iter()
        .filter(|m| m.message.turn_id.as_deref() == Some(&turn.id))
        .collect();
    let user = messages
        .iter()
        .filter(|m| m.message.role == ConversationRole::User)
        .map(|m| text_for_message(m, ToolParts::Exclude))
        .collect::<Vec<_>>()
        .join("\n");
    let hook_context = messages
        .iter()
        .filter(|m| m.message.role == ConversationRole::Developer)
        .map(|m| text_for_message(m, ToolParts::Exclude))
        .collect::<Vec<_>>()
        .join("\n");
    let final_id = material
        .outcomes
        .iter()
        .find(|o| o.turn_id == turn.id)
        .and_then(|o| o.public_assistant_message_id.as_deref());
    let answer = messages
        .iter()
        .rev()
        .find(|m| {
            m.message.role == ConversationRole::Assistant
                && final_id.is_none_or(|id| id == m.message.id)
        })
        .map(|m| text_for_message(m, ToolParts::Exclude))
        .unwrap_or_default();
    let mut tools = std::collections::BTreeSet::new();
    for part in messages.iter().flat_map(|m| &m.parts) {
        if part.kind == ConversationPartKind::ToolCall {
            for key in ["safeToolName", "toolName", "name"] {
                if let Some(name) = part
                    .content_json
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                {
                    tools.insert(name.to_owned());
                    break;
                }
            }
        }
    }
    ContinuityTurn {
        number: turn.seq,
        status: match turn.status.as_str() {
            "aborted" => "cancelled".into(),
            other => other.into(),
        },
        user,
        hook_context,
        answer,
        tools: tools.into_iter().collect(),
    }
}
