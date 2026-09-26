//! One pinned-read candidate pass; source corpus audit follows raw retrieval.

mod rank;
mod seeds;

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::{
    CognitionResult, MemoryGenerationHandle,
    graph::{
        CurrentVectorMatches, GraphRecallReader, ProjectionCoverage, RecallEpisodeRow,
        RecallMention, RelationshipState,
    },
    recall::{GraphExpansion, RankedEpisode, RecallRequest, RecallVectorMatches},
    sources::{CanonicalInventory, read_canonical_inventory},
};
use crate::conversation::ConversationSourceReader;

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
    pub(super) overall_deadline: i64,
    pub(super) now_iso: &'a str,
    pub(super) now_millis: &'a dyn Fn() -> i64,
    pub(super) parse_date: &'a dyn Fn(&str) -> f64,
    pub(super) compare_locale: &'a dyn Fn(&str, &str) -> std::cmp::Ordering,
}

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
        overall_deadline,
        now_iso,
        now_millis,
        parse_date,
        compare_locale,
    } = request;
    let admitted = input.admitted_channels.clone().unwrap_or_default();
    let raw = if admitted.lexical {
        graph.raw_source_candidates(input, candidate_deadline, now_millis)?
    } else {
        crate::cognition::graph::RawSourceSelection {
            sources: vec![],
            partial: false,
        }
    };
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
    let recent = canonical
        .map(|reader| reader.read_recent_public_message_ids(&input.runtime.session_id))
        .transpose()
        .map_err(|error| {
            crate::cognition::CognitionError::new("canonical_source_unavailable", error.to_string())
        })?
        .unwrap_or_default();
    let semantic = graph.semantic_seeds(
        input,
        &recent,
        vector_current
            .as_ref()
            .map_or(&[], |current| current.nodes.as_slice()),
        candidate_deadline,
        now_millis,
    )?;
    let temporal = if admitted.context {
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
        semantic,
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
        seeds,
        raw,
        coverage,
        overall_deadline,
        now_iso,
        now_millis,
        parse_date,
    )?;
    selected.vector_current = vector_current;
    Ok(selected)
}
