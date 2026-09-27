//! Original-source evidence hydration and canonical revision currentness.

mod current;
mod hydrate;
#[cfg(test)]
mod tests;

use std::{collections::HashMap, path::Path, sync::Arc};

use crate::cognition::{CognitionSourceRow, recall::RecallSourceEpisode};
use crate::conversation::ConversationSourceReader;

pub(in crate::cognition) struct RecallSourceHydration<'a, N, C> {
    pub data_root: &'a Path,
    pub memory_root: &'a Path,
    pub reader: Option<&'a ConversationSourceReader>,
    pub rows: &'a [CognitionSourceRow],
    pub episodes: &'a [RecallSourceEpisode],
    pub max_graphemes: usize,
    pub deadline_at: i64,
    pub now_millis: N,
    pub compare_locale: C,
}

#[derive(Clone, Debug)]
pub(in crate::cognition) struct ResolvedRecallSource {
    pub source_ref: String,
    pub source_kind: String,
    pub scalar: Arc<str>,
    pub start: usize,
    pub end: usize,
    pub excerpt: String,
    pub source_hash: String,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub basis: String,
}

impl ResolvedRecallSource {
    pub(in crate::cognition) fn text(&self) -> &str {
        &self.scalar[self.start..self.end]
    }
}

#[derive(Clone, Debug)]
pub(in crate::cognition) enum RecallSourceResolution {
    Value(Box<ResolvedRecallSource>),
    Changed,
    Deadline,
}

pub(in crate::cognition) fn hydrate_recall_sources<N, C>(
    request: RecallSourceHydration<'_, N, C>,
) -> HashMap<String, RecallSourceResolution>
where
    N: FnMut() -> i64,
    C: Fn(&str, &str) -> std::cmp::Ordering,
{
    hydrate::run(request)
}

pub(in crate::cognition) fn identity_binding_current(
    data_root: &Path,
    memory_root: &Path,
    reader: Option<&ConversationSourceReader>,
    row: &CognitionSourceRow,
    binding: &crate::cognition::recall::IdentitySourceBinding,
    episode: &RecallSourceEpisode,
) -> bool {
    if row.source_id != binding.source_ref
        || row.episode_id != binding.episode_id
        || row.revision != binding.revision
        || row.content_hash != binding.content_hash
        || row.byte_start != binding.byte_start as f64
        || row.byte_end != binding.byte_end as f64
        || row.conversation_session_id.as_deref() != Some(&binding.session_id)
        || row.origin_kind != binding.origin_kind
        || row.role != binding.role
        || row.observed_at != binding.observed_at
    {
        return false;
    }
    if episode.episode_id != binding.episode_id
        || episode.revision != binding.revision
        || episode.session_id != binding.session_id
    {
        return false;
    }
    let resolved = hydrate_recall_sources(RecallSourceHydration {
        data_root,
        memory_root,
        reader,
        rows: std::slice::from_ref(row),
        episodes: std::slice::from_ref(episode),
        max_graphemes: usize::MAX,
        deadline_at: i64::MAX,
        now_millis: || 0,
        compare_locale: |a: &str, b: &str| a.cmp(b),
    });
    let Some(RecallSourceResolution::Value(source)) = resolved.get(&row.source_id) else {
        return false;
    };
    if binding.quote.is_empty() {
        return true;
    }
    let Some(start) = binding
        .quote_byte_start
        .checked_sub(binding.byte_start)
        .and_then(|n| usize::try_from(n).ok())
    else {
        return false;
    };
    let Some(end) = binding
        .quote_byte_end
        .checked_sub(binding.byte_start)
        .and_then(|n| usize::try_from(n).ok())
    else {
        return false;
    };
    source
        .text()
        .as_bytes()
        .get(start..end)
        .is_some_and(|bytes| std::str::from_utf8(bytes).ok() == Some(binding.quote.as_str()))
}
