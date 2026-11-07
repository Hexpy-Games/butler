//! `app/composerDraftCache.ts`: per-session drafts.
//!
//! One in-memory layer: the shell has no origin storage and no second durable cache, so the
//! `newestComposerDraft` merge of the two has nothing to merge. A write count orders drafts
//! where React orders by `updated_at`.
#![allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]
use std::collections::HashMap;

use crate::ui::source::wire::{MessageContent, MessageContentPart};

/// `sharedCacheBudget.maxComposerDraftBytes`
const MAX_DRAFT_BYTES: usize = 65_536;
/// `sharedCacheBudget.maxComposerDraftEntries`
const MAX_DRAFT_ENTRIES: usize = 8;
/// `sharedCacheBudget.maxComposerDraftAggregateBytes`
const MAX_DRAFT_AGGREGATE_BYTES: usize = 524_288;

/// `ComposerDraftSnapshot`
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ComposerDraftSnapshot {
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) content_parts: Option<MessageContent>,
    updated_at: u64,
}

impl ComposerDraftSnapshot {
    /// `draftTextWithinBudget` measures the serialized snapshot; this sums its strings.
    fn bytes(&self) -> usize {
        let parts = self.content_parts.as_ref().map_or(0, |content| {
            content.parts.iter().map(part_bytes).sum::<usize>()
        });
        self.session_id.len() + self.text.len() + parts
    }
}

fn part_bytes(part: &MessageContentPart) -> usize {
    match part {
        MessageContentPart::Text { text } => text.len(),
        MessageContentPart::SessionRef {
            sessionId,
            titleSnapshot,
        } => sessionId.len() + titleSnapshot.len(),
        MessageContentPart::ProjectRef {
            projectId,
            titleSnapshot,
        } => projectId.len() + titleSnapshot.len(),
        MessageContentPart::ProjectSourceRef {
            projectId,
            source,
            titleSnapshot,
            topic,
        } => {
            projectId.len()
                + source.id.len()
                + source.revision.len()
                + titleSnapshot.len()
                + topic.as_ref().map_or(0, String::len)
        }
    }
}

#[derive(Default)]
pub(crate) struct DraftCache {
    entries: HashMap<String, ComposerDraftSnapshot>,
    writes: u64,
}

impl DraftCache {
    /// `readLocalComposerDraft`
    pub(crate) fn read(&self, session_id: &str) -> Option<&ComposerDraftSnapshot> {
        self.entries.get(session_id)
    }

    /// `writeCachedComposerDraft`: a draft over the byte budget is not stored.
    pub(crate) fn write(
        &mut self,
        session_id: &str,
        text: &str,
        content_parts: Option<&MessageContent>,
    ) -> bool {
        self.writes += 1;
        let snapshot = ComposerDraftSnapshot {
            session_id: session_id.to_owned(),
            text: text.to_owned(),
            content_parts: content_parts.cloned(),
            updated_at: self.writes,
        };
        if snapshot.bytes() > MAX_DRAFT_BYTES {
            return false;
        }
        self.entries.insert(session_id.to_owned(), snapshot);
        self.evict(session_id);
        true
    }

    /// `evictLocalComposerDrafts`: oldest first, never the session just written.
    fn evict(&mut self, protected: &str) {
        let mut candidates: Vec<(u64, String, usize)> = (self.entries.iter())
            .map(|(key, draft)| (draft.updated_at, key.clone(), draft.bytes()))
            .collect();
        candidates.sort();
        let mut total: usize = candidates.iter().map(|(_, _, bytes)| bytes).sum();
        let mut count = candidates.len();
        for (_, key, bytes) in candidates {
            if count <= MAX_DRAFT_ENTRIES && total <= MAX_DRAFT_AGGREGATE_BYTES {
                break;
            }
            if key == protected {
                continue;
            }
            self.entries.remove(&key);
            count -= 1;
            total -= bytes;
        }
    }
}
