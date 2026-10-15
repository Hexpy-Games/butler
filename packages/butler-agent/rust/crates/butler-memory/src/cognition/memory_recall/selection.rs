//! One pinned-read candidate pass; source corpus audit follows raw retrieval.

mod fallback;
mod rank;
mod seeds;

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::CognitionCode;
use crate::cognition::{
    CognitionResult, MemoryGenerationHandle,
    graph::{
        CurrentVectorMatches, GraphRecallReader, ProjectionCoverage, RecallEpisodeRow,
        RecallMention, RelationshipState,
    },
    recall::{GraphExpansion, RankedEpisode, RecallRequest, RecallVectorMatches},
    sources::{CanonicalInventory, read_canonical_inventory},
};
use butler_turn::conversation::ConversationSourceReader;

pub(super) struct Selection {
    pub empty_search: bool,
    pub ranked: Vec<RankedEpisode>,
    pub rows: HashMap<String, RecallEpisodeRow>,
    pub mentions: HashMap<String, Vec<RecallMention>>,
    pub relationships: HashMap<String, RelationshipState>,
    pub expansion: GraphExpansion,
    pub raw_source_ids: HashSet<String>,
    pub raw_episode_ids: HashSet<String>,
    pub coverage: ProjectionCoverage,
    pub selection_codes: Vec<String>,
    pub candidate_limit: bool,
    pub vector_current: Option<CurrentVectorMatches>,
    pub metrics: Vec<super::metrics::Candidate>,
    pub executed: super::metrics::Executed,
}

#[derive(Clone, Copy)]
pub(super) struct RecallSelectionInput<'a> {
    pub(super) graph: &'a GraphRecallReader,
    pub(super) canonical: Option<&'a ConversationSourceReader>,
    pub(super) data_root: &'a Path,
    pub(super) memory_root: &'a Path,
    pub(super) generation: &'a MemoryGenerationHandle,
    pub(super) input: &'a RecallRequest,
    pub(super) vector_matches: Option<&'a RecallVectorMatches>,
    pub(super) candidate_deadline: i64,
    pub(super) graph_deadline: i64,
    pub(super) now_iso: &'a str,
    pub(super) now_millis: &'a dyn Fn() -> i64,
    pub(super) parse_date: &'a dyn Fn(&str) -> f64,
    pub(super) compare_locale: &'a dyn Fn(&str, &str) -> std::cmp::Ordering,
}

/// Selects and ranks recall candidates from every admitted channel.
pub(super) fn run(request: RecallSelectionInput<'_>) -> CognitionResult<Selection> {
    let RecallSelectionInput {
        graph,
        canonical,
        data_root,
        memory_root,
        generation,
        input,
        vector_matches,
        candidate_deadline,
        graph_deadline,
        now_iso,
        now_millis,
        parse_date,
        compare_locale,
    } = request;
    let (fts, fts_partial) = fallback::candidates(&request)?;
    let raw = lexical_sources(&request)?;
    let inventory: CanonicalInventory = read_canonical_inventory(
        canonical,
        input,
        candidate_deadline,
        parse_date,
        compare_locale,
        now_millis,
    )?;
    let coverage = graph.projection_coverage(input, &inventory)?;
    let vector_current = vector_matches
        .map(|matches| graph.current_vector_matches(input, generation, matches, parse_date))
        .transpose()?;
    let recent = recent_message_ids(canonical, input)?;
    let semantic = graph.semantic_seeds(
        input,
        &recent,
        vector_current
            .as_ref()
            .map_or(&[], |current| current.nodes.as_slice()),
        candidate_deadline,
        now_millis,
    )?;
    let temporal = if input.admitted_channels.clone().unwrap_or_default().context {
        graph.temporal_seeds(input, parse_date)?
    } else {
        Default::default()
    };
    let seeds = seeds::expand(
        graph,
        canonical,
        data_root,
        memory_root,
        input,
        fallback::coverage(semantic, fts_partial),
        temporal,
        &raw,
        vector_current.as_ref(),
        graph_deadline,
        now_millis,
        parse_date,
    )?;
    let mut selected = rank::rank(
        graph,
        input,
        fallback::merge(&request, seeds, fts)?,
        raw,
        coverage,
        now_iso,
        parse_date,
    )?;
    selected.vector_current = vector_current;
    Ok(selected)
}

/// Raw lexical source candidates; none when the lexical channel is not
/// admitted.
fn lexical_sources(
    request: &RecallSelectionInput<'_>,
) -> CognitionResult<crate::cognition::graph::RawSourceSelection> {
    let input = request.input;
    if !input.admitted_channels.clone().unwrap_or_default().lexical {
        return Ok(crate::cognition::graph::RawSourceSelection {
            sources: vec![],
            partial: false,
        });
    }
    request
        .graph
        .raw_source_candidates(input, request.candidate_deadline, request.now_millis)
}

/// The caller session's recent public message ids (none without a canonical
/// snapshot).
fn recent_message_ids(
    canonical: Option<&ConversationSourceReader>,
    input: &RecallRequest,
) -> CognitionResult<Vec<String>> {
    Ok(canonical
        .map(|reader| reader.read_recent_public_message_ids(&input.runtime.session_id))
        .transpose()
        .map_err(|error| {
            crate::cognition::CognitionError::new(
                CognitionCode::CanonicalSourceUnavailable,
                error.to_string(),
            )
            .with_source(error)
        })?
        .unwrap_or_default())
}
