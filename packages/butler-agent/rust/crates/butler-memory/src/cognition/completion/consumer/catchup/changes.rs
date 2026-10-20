//! Reconcile changed sources through the bounded canonical change log.

use super::{
    CatchupState, CognitionCode, CognitionConversationSourceNotice, CognitionError,
    CognitionResult, ConversationSourceReader, NOTICE_BUDGET, Pass, error,
};
use butler_turn::conversation::SourceChangeKind;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

/// Feed continuation is independent of append-inventory reconciliation.
pub(super) fn pending(state: &CatchupState) -> bool {
    state
        .change_mark
        .as_ref()
        .zip(state.change_head)
        .is_some_and(|(mark, head)| mark.seq < head)
}

/// Bind the watermark to this store. Missing or pruned history requires a
/// bounded inventory sweep; subsequent edits are read after its starting head.
pub(super) fn prepare(
    canonical: &ConversationSourceReader,
    state: &mut CatchupState,
    identity: Option<&str>,
) -> CognitionResult<(bool, bool)> {
    let Some(head) = canonical
        .source_change_head()
        .map_err(CognitionError::from)?
    else {
        return Ok((false, false));
    };
    state.change_head = Some(head.seq);
    if let Some(mark) = &state.change_mark
        && state.source_identity.as_deref() == identity
        && canonical
            .source_change_holds(mark)
            .map_err(CognitionError::from)?
    {
        return Ok((mark != &head, false));
    }
    state.change_mark = Some(head);
    Ok((true, true))
}

impl Pass {
    /// Changes name sources directly, including edits behind the append cursor.
    /// The watermark is saved only after the pass registers all its notices.
    pub(super) fn read_changes(
        &mut self,
        canonical: &ConversationSourceReader,
        graph_path: &Path,
    ) -> CognitionResult<()> {
        let Some(mark) = &self.state.change_mark else {
            return Ok(());
        };
        let changes = canonical
            .read_source_changes(mark.seq, NOTICE_BUDGET)
            .map_err(CognitionError::from)?;
        // Pruning can race the page read; never checkpoint across a gap.
        if !canonical
            .source_change_holds(mark)
            .map_err(CognitionError::from)?
        {
            self.state.change_mark = canonical
                .source_change_head()
                .map_err(CognitionError::from)?;
            self.state.change_head = self.state.change_mark.as_ref().map(|mark| mark.seq);
            self.start_sweep();
            return Ok(());
        }
        let floor = open_floor(graph_path)?;
        let mut messages = HashSet::new();
        let mut turns = HashSet::new();
        for change in &changes {
            match change.kind {
                SourceChangeKind::Message if messages.insert(&change.entity_id) => {
                    self.push_recovered(canonical, &floor, &change.entity_id)?;
                }
                SourceChangeKind::Turn if turns.insert(&change.entity_id) => {
                    self.push_turn(canonical, &floor, &change.entity_id)?;
                }
                _ => {}
            }
        }
        if let Some(last) = changes.last() {
            self.state.change_mark = Some(last.mark());
        }
        self.scanned += changes.len();
        Ok(())
    }

    /// Fills the rest of the 256-notice budget with recovered standalone
    /// messages after the message cursor.
    pub(super) fn read_recovered_sources(
        &mut self,
        canonical: &ConversationSourceReader,
        graph_path: &std::path::Path,
    ) -> CognitionResult<()> {
        let floor = open_floor(graph_path)?;
        let remaining = NOTICE_BUDGET - self.work.len();
        let mut scanned = 0;
        while scanned < remaining {
            // Append pages stay bounded; only compact notices survive the awaits.
            let batch_size = (remaining - scanned).min(16);
            let ids = canonical
                .read_recovered_source_ids_page(self.state.message.as_deref(), Some(batch_size))
                .map_err(CognitionError::from)?;
            let count = ids.len();
            self.scanned += count;
            for id in ids {
                self.state.message = Some(id.clone());
                self.push_recovered(canonical, &floor, &id)?;
            }
            scanned += count;
            if count < batch_size {
                self.messages_at_end = true;
                break;
            }
        }
        Ok(())
    }

    /// A restored outcome or terminal status can sit behind the append cursor.
    /// Revalidate its old observation when its windows failed source validation.
    fn push_turn(
        &mut self,
        canonical: &ConversationSourceReader,
        floor: &rusqlite::Connection,
        id: &str,
    ) -> CognitionResult<()> {
        if !crate::cognition::graph::source_validity::needs_revalidation(
            floor,
            &format!("conversation_turn:{id}"),
        )? {
            return Ok(());
        }
        if crate::coordination::admission_suppressed(floor, "turn", id).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })? {
            return Ok(());
        }
        let Some(outcome) = canonical.read_recall_outcome(id)? else {
            return Ok(());
        };
        self.work.push((
            CognitionConversationSourceNotice::Turn {
                session_id: outcome.session_id,
                turn_id: outcome.turn_id,
                outcome_generation: outcome.generation,
                extraction_version: "memory-extract-v3".into(),
            },
            format!("catchup:outcome:{}", outcome.id),
        ));
        Ok(())
    }

    fn push_recovered(
        &mut self,
        canonical: &ConversationSourceReader,
        floor: &rusqlite::Connection,
        id: &str,
    ) -> CognitionResult<()> {
        if crate::coordination::admission_suppressed(floor, "message", id).map_err(|source| {
            error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
        })? {
            return Ok(());
        }
        let Some(message) = canonical
            .read_recovered_source(id)
            .map_err(CognitionError::from)?
        else {
            return Ok(());
        };
        let hash = recovered_source_hash(&message.parts)?;
        self.work.push((
            CognitionConversationSourceNotice::Standalone {
                session_id: message.message.session_id,
                message_id: message.message.id.clone(),
                source_hash: hash.clone(),
                extraction_version: "memory-extract-v3".into(),
            },
            format!("catchup:message:{}:{hash}", message.message.id),
        ));
        Ok(())
    }
}

fn open_floor(path: &Path) -> CognitionResult<butler_platform::sqlite::Connection> {
    butler_platform::sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))
}

fn recovered_source_hash(
    parts: &[butler_turn::conversation::ConversationPart],
) -> CognitionResult<String> {
    let mut encoded = String::from("[");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            encoded.push(',');
        }
        encoded.push('[');
        encoded.push_str(&serde_json::to_string(&part.id).map_err(json_error)?);
        encoded.push(',');
        butler_core::json::append_json(&part.content_json, &mut encoded).map_err(json_error)?;
        encoded.push(']');
    }
    encoded.push(']');
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}

fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryCatchupJsonError, error.to_string()).with_source(error)
}
