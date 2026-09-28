//! Typed-first original source hydration, query-local scalar sharing, source deadlines.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    sync::Arc,
};

use crate::cognition::{CognitionSourceRow, hydrate_conversation_source};
use butler_core::segmentation::grapheme_segments;
use butler_turn::conversation::{ConversationMessageWithParts, ConversationSourceReader};

use super::super::typed::{TypedMemoryRecord, read_typed_record};
use super::{RecallSourceHydration, RecallSourceResolution, ResolvedRecallSource, current};

pub(super) fn run<N, C>(
    request: RecallSourceHydration<'_, N, C>,
) -> HashMap<String, RecallSourceResolution>
where
    N: FnMut() -> i64,
    C: Fn(&str, &str) -> Ordering,
{
    let RecallSourceHydration {
        data_root,
        memory_root,
        reader,
        rows,
        episodes,
        max_graphemes,
        deadline_at,
        mut now_millis,
        compare_locale,
    } = request;
    let mut output = HashMap::with_capacity(rows.len());
    hydrate_typed(data_root, memory_root, rows, max_graphemes, &mut output);
    let mut conversation = rows
        .iter()
        .filter(|row| row.source_kind == "conversation")
        .collect::<Vec<_>>();
    let Some(reader) = reader else {
        for row in conversation {
            output.insert(row.source_id.clone(), RecallSourceResolution::Changed);
        }
        return output;
    };
    conversation.sort_by(|a, b| {
        compare_locale(
            a.conversation_message_id.as_deref().unwrap_or(""),
            b.conversation_message_id.as_deref().unwrap_or(""),
        )
        .then_with(|| compare_locale(&a.part_id, &b.part_id))
        .then_with(|| compare_locale(&a.scalar_pointer, &b.scalar_pointer))
        .then_with(|| a.byte_start.total_cmp(&b.byte_start))
    });
    let mut hydration = Conversation {
        reader,
        episodes,
        current_episodes: episodes
            .iter()
            .filter(|episode| episode.turn_id.is_some() && current::episode(reader, episode, None))
            .map(|episode| (episode.episode_id.as_str(), episode.revision.as_str()))
            .collect(),
        max_graphemes,
        messages: HashMap::new(),
        scalars: HashMap::new(),
        standalone_current: HashMap::new(),
    };
    for row in conversation {
        if now_millis() >= deadline_at {
            output.insert(row.source_id.clone(), RecallSourceResolution::Deadline);
            continue;
        }
        let value = if hydration.is_current(row) {
            hydration.resolve(row)
        } else {
            None
        };
        output.insert(row.source_id.clone(), resolution(value));
    }
    output
}

fn resolution(value: Option<ResolvedRecallSource>) -> RecallSourceResolution {
    value.map_or(RecallSourceResolution::Changed, |value| {
        RecallSourceResolution::Value(Box::new(value))
    })
}

/// Resolves the typed (non-conversation) rows, reading each typed record
/// once.
fn hydrate_typed(
    data_root: &std::path::Path,
    memory_root: &std::path::Path,
    rows: &[CognitionSourceRow],
    max_graphemes: usize,
    output: &mut HashMap<String, RecallSourceResolution>,
) {
    let mut typed_cache = HashMap::<(String, String), Option<(TypedMemoryRecord, Arc<str>)>>::new();
    for row in rows.iter().filter(|row| row.source_kind != "conversation") {
        let key = (row.source_kind.clone(), row.part_id.clone());
        let record = typed_cache.entry(key).or_insert_with(|| {
            read_typed_record(data_root, memory_root, &row.source_kind, &row.part_id)
                .ok()
                .flatten()
                .map(|record| {
                    let scalar = Arc::<str>::from(record.text.as_str());
                    (record, scalar)
                })
        });
        let value = record
            .as_ref()
            .and_then(|(record, scalar)| typed(row, record, scalar.clone(), max_graphemes));
        output.insert(row.source_id.clone(), resolution(value));
    }
}

/// Conversation rows of one query, sharing message reads, scalars and
/// currency checks.
struct Conversation<'a> {
    reader: &'a ConversationSourceReader,
    episodes: &'a [super::RecallSourceEpisode],
    /// Turn episodes whose recorded revision is still current.
    current_episodes: HashSet<(&'a str, &'a str)>,
    max_graphemes: usize,
    messages: HashMap<String, Option<ConversationMessageWithParts>>,
    scalars: HashMap<(String, String, String), Arc<str>>,
    standalone_current: HashMap<(String, String), bool>,
}

impl Conversation<'_> {
    /// Whether the row's episode revision is still the current one.
    fn is_current(&mut self, row: &CognitionSourceRow) -> bool {
        if self.episodes.is_empty()
            || self
                .current_episodes
                .contains(&(row.episode_id.as_str(), row.revision.as_str()))
        {
            return true;
        }
        let episode = self.episodes.iter().find(|episode| {
            episode.episode_id == row.episode_id && episode.revision == row.revision
        });
        let reader = self.reader;
        episode
            .filter(|episode| episode.turn_id.is_none())
            .is_some_and(|episode| {
                let key = (episode.episode_id.clone(), episode.revision.clone());
                *self
                    .standalone_current
                    .entry(key)
                    .or_insert_with(|| current::episode(reader, episode, Some(row)))
            })
    }

    /// The row's excerpt from its message, or `None` when the message or
    /// span no longer matches.
    fn resolve(&mut self, row: &CognitionSourceRow) -> Option<ResolvedRecallSource> {
        let id = row.conversation_message_id.as_deref()?;
        if !self.messages.contains_key(id) {
            let message = self.reader.read_message(id).ok().flatten();
            self.messages.insert(id.to_owned(), message);
        }
        let message = self.messages.get(id)?.as_ref()?;
        let hydrated = hydrate_conversation_source(message, row, self.max_graphemes as f64).ok()?;
        let key = (
            id.to_owned(),
            row.part_id.clone(),
            row.scalar_pointer.clone(),
        );
        let scalar = self
            .scalars
            .entry(key)
            .or_insert_with(|| Arc::<str>::from(hydrated.scalar_text))
            .clone();
        let (start, end) = span(row, scalar.len())?;
        Some(ResolvedRecallSource {
            source_ref: row.source_id.clone(),
            source_kind: row.source_kind.clone(),
            scalar,
            start,
            end,
            excerpt: hydrated.excerpt.into_owned(),
            source_hash: row.content_hash.clone(),
            conversation_session_id: row.conversation_session_id.clone(),
            conversation_message_id: row.conversation_message_id.clone(),
            basis: row.basis.clone(),
        })
    }
}

fn typed(
    row: &CognitionSourceRow,
    owner: &TypedMemoryRecord,
    scalar: Arc<str>,
    max_graphemes: usize,
) -> Option<ResolvedRecallSource> {
    if row.source_kind != owner.source_kind
        || row.revision != owner.revision
        || row.content_hash != owner.content_hash
        || row.conversation_session_id != owner.conversation_session_id
        || row.role != owner.role
        || row.basis != owner.basis
    {
        return None;
    }
    let (start, end) = span(row, scalar.len())?;
    let excerpt = truncate(scalar.get(start..end)?, max_graphemes);
    Some(ResolvedRecallSource {
        source_ref: row.source_id.clone(),
        source_kind: row.source_kind.clone(),
        scalar,
        start,
        end,
        excerpt,
        source_hash: row.content_hash.clone(),
        conversation_session_id: row.conversation_session_id.clone(),
        conversation_message_id: owner.conversation_message_id.clone(),
        basis: owner.basis.into(),
    })
}

fn span(row: &CognitionSourceRow, len: usize) -> Option<(usize, usize)> {
    if !row.byte_start.is_finite()
        || !row.byte_end.is_finite()
        || row.byte_start < 0.0
        || row.byte_end <= row.byte_start
        || row.byte_end > len as f64
        || row.byte_start.fract() != 0.0
        || row.byte_end.fract() != 0.0
    {
        return None;
    }
    Some((
        butler_core::json::saturating_usize(row.byte_start),
        butler_core::json::saturating_usize(row.byte_end),
    ))
}
fn truncate(text: &str, max: usize) -> String {
    let end = grapheme_segments(text)
        .nth(max)
        .map_or(text.len(), |segment| segment.start);
    text.get(..end).unwrap_or(text).to_owned()
}
