//! Identity-aware semantic/temporal expansion and source mention composition.
//!
//! [`expand`] bounds the seed nodes (semantic first, then temporal, 16 in
//! all), resolves each to its identity, expands the graph from them, and
//! gathers the source mentions of every reachable node plus the episodes
//! found directly (temporal, vector and raw lexical hits).

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::{
    CognitionError, CognitionResult,
    graph::{
        CurrentVectorMatches, GraphRecallReader, RawSourceSelection, RecallMention,
        TemporalSelection,
    },
    recall::{
        EligibleAdjacency, GraphExpansion, IdentityMembers, IdentityReadScope,
        IdentitySourceBinding, RecallEdge, RecallRequest, RecallVectorMatch, SemanticSelection,
    },
    sources::identity_binding_current,
};
use butler_turn::conversation::ConversationSourceReader;

/// Seed nodes, their expansion and the mentions ranking reads.
pub(super) struct SeedGraph {
    pub expansion: GraphExpansion,
    pub selected: SemanticSelection,
    pub temporal_episode_ids: Vec<String>,
    pub vector_episodes: Vec<RecallVectorMatch>,
    pub vector_searched: bool,
    pub fts_episodes: Vec<String>,
    pub fts_searched: bool,
    pub mentions: Vec<RecallMention>,
    pub raw_episode_ids: HashSet<String>,
}

/// The pinned sources identity checks read.
struct IdentitySources<'a> {
    graph: &'a GraphRecallReader,
    canonical: Option<&'a ConversationSourceReader>,
    data_root: &'a Path,
    memory_root: &'a Path,
}

impl IdentitySources<'_> {
    /// Whether the binding's source row is still current for its episode.
    fn source_current(&self, binding: &IdentitySourceBinding) -> bool {
        let Ok(rows) = self
            .graph
            .source_rows(std::slice::from_ref(&binding.source_ref))
        else {
            return false;
        };
        let Ok(Some(episode)) = self.graph.episode_identity(&binding.episode_id) else {
            return false;
        };
        rows.iter().any(|row| {
            identity_binding_current(
                self.data_root,
                self.memory_root,
                self.canonical,
                row,
                binding,
                &episode,
            )
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn expand(
    graph: &GraphRecallReader,
    canonical: Option<&ConversationSourceReader>,
    data_root: &Path,
    memory_root: &Path,
    input: &RecallRequest,
    mut selected: SemanticSelection,
    temporal: TemporalSelection,
    raw: &RawSourceSelection,
    vector: Option<&CurrentVectorMatches>,
    graph_deadline: i64,
    now_millis: &dyn Fn() -> i64,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<SeedGraph> {
    bound_seeds(&mut selected, input, &temporal, raw);
    let raw_episode_ids = raw
        .sources
        .iter()
        .map(|source| source.episode_id.clone())
        .collect::<HashSet<_>>();
    let direct_episode_ids = temporal
        .episode_ids
        .iter()
        .cloned()
        .chain(
            vector
                .into_iter()
                .flat_map(|current| current.episodes.iter().map(|hit| hit.owner_id.clone())),
        )
        .chain(raw.sources.iter().map(|source| source.episode_id.clone()))
        .collect::<Vec<_>>();
    let sources = IdentitySources {
        graph,
        canonical,
        data_root,
        memory_root,
    };
    let scope = IdentityReadScope {
        as_of: input.as_of.clone(),
        scope: input.scope,
        current_session_id: input.runtime.session_id.clone(),
        current_project_id: input.runtime.project_id.clone(),
        session_ids: input.session_ids.clone(),
        project_filter: input.project_filter,
        project_ids: input.project_ids.clone(),
        include_internal: input.include_internal,
        deadline_at: graph_deadline,
    };
    let resolved = resolve_seeds(&sources, &mut selected, &scope, now_millis, parse_date)?;
    let expansion = expand_graph(
        &sources,
        input,
        &resolved,
        &scope,
        graph_deadline,
        now_millis,
        parse_date,
    )?;
    let mentions = mentions(
        graph,
        input,
        &expansion,
        &direct_episode_ids,
        raw,
        &raw_episode_ids,
    )?;
    Ok(SeedGraph {
        expansion,
        selected,
        temporal_episode_ids: temporal.episode_ids,
        vector_episodes: vector.map_or_else(Vec::new, |current| current.episodes.clone()),
        vector_searched: vector.is_some(),
        fts_episodes: Vec::new(),
        fts_searched: false,
        mentions,
        raw_episode_ids,
    })
}

/// At most 16 seeds: semantic seeds (fewer when a time range brings temporal
/// seeds), then new temporal seeds.
fn bound_seeds(
    selected: &mut SemanticSelection,
    input: &RecallRequest,
    temporal: &TemporalSelection,
    raw: &RawSourceSelection,
) {
    let semantic_limit = if input.time.is_some() {
        16usize.saturating_sub(temporal.seeds.len())
    } else {
        16
    };
    selected.seeds = selected
        .all_seeds
        .iter()
        .take(semantic_limit)
        .cloned()
        .collect();
    for seed in temporal.seeds.iter().take(16 - selected.seeds.len()) {
        if !selected.seeds.contains(seed) {
            selected.seeds.push(seed.clone());
        }
    }
    if raw.partial {
        selected.coverage_codes.push("lexical_partial".into());
    }
}

/// The distinct identity node of every seed.
fn resolve_seeds(
    sources: &IdentitySources<'_>,
    selected: &mut SemanticSelection,
    scope: &IdentityReadScope,
    now_millis: &dyn Fn() -> i64,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<Vec<String>> {
    let mut source_current = |binding: &IdentitySourceBinding| sources.source_current(binding);
    let mut resolved = Vec::new();
    let mut dedup = HashSet::new();
    for seed in &selected.seeds {
        let result = sources.graph.resolve_identity(
            seed,
            scope,
            parse_date,
            &mut source_current,
            &mut || now_millis(),
        )?;
        if result.partial {
            selected.coverage_codes.push("identity_partial".into());
        }
        if dedup.insert(result.node_id.clone()) {
            resolved.push(result.node_id);
        }
    }
    Ok(resolved)
}

/// Expands from the resolved nodes over eligible adjacency (none when the
/// graph channel is not admitted) and identity members.
fn expand_graph(
    sources: &IdentitySources<'_>,
    input: &RecallRequest,
    resolved: &[String],
    scope: &IdentityReadScope,
    graph_deadline: i64,
    now_millis: &dyn Fn() -> i64,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<GraphExpansion> {
    let graph = sources.graph;
    let admitted = input.admitted_channels.clone().unwrap_or_default();
    let mut source_current = |binding: &IdentitySourceBinding| sources.source_current(binding);
    let mut members = |node: &str, limit: usize| {
        let result = graph.identity_members(
            node,
            scope,
            limit,
            parse_date,
            &mut source_current,
            &mut || now_millis(),
        )?;
        Ok::<_, CognitionError>(IdentityMembers {
            members: result.members,
            partial: result.partial,
        })
    };
    let mut adjacency_cache = HashMap::<(String, usize, usize), (Vec<RecallEdge>, bool)>::new();
    crate::cognition::recall::expand_graph(
        resolved,
        |node, limit, offset| {
            if !admitted.graph {
                return Ok(EligibleAdjacency {
                    edges: vec![],
                    truncated: false,
                });
            }
            let key = (node.to_owned(), limit, offset);
            if let Some((edges, truncated)) = adjacency_cache.get(&key) {
                return Ok(EligibleAdjacency {
                    edges: edges.clone(),
                    truncated: *truncated,
                });
            }
            let page = graph.eligible_adjacency(input, node, limit, offset)?;
            adjacency_cache.insert(key, (page.edges.clone(), page.truncated));
            Ok::<_, CognitionError>(page)
        },
        graph_deadline,
        now_millis,
        Some(&mut members),
    )
}

/// Mentions of reachable nodes, plus the direct episodes' mentions (or their
/// sources when they have none), plus the raw hit sources not yet present.
fn mentions(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    expansion: &GraphExpansion,
    direct_episode_ids: &[String],
    raw: &RawSourceSelection,
    raw_episode_ids: &HashSet<String>,
) -> CognitionResult<Vec<RecallMention>> {
    let reachable = expansion.paths.keys().cloned().collect::<Vec<_>>();
    let mut mentions = graph.mentions_for_nodes(input, &reachable)?;
    let direct = graph.mentions_for_episodes(input, direct_episode_ids)?;
    for mention in &direct {
        if !mentions
            .iter()
            .any(|item| item.source_id == mention.source_id && item.node_id == mention.node_id)
        {
            mentions.push(mention.clone());
        }
    }
    let episodes_with_mentions = direct
        .iter()
        .map(|item| item.episode_id.as_str())
        .collect::<HashSet<_>>();
    let without_mentions = direct_episode_ids
        .iter()
        .filter(|id| !episodes_with_mentions.contains(id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    mentions.extend(graph.episode_sources(input, &without_mentions)?);
    let raw_source_ids = raw
        .sources
        .iter()
        .map(|item| item.source_id.as_str())
        .collect::<HashSet<_>>();
    for source in
        graph.episode_sources(input, &raw_episode_ids.iter().cloned().collect::<Vec<_>>())?
    {
        if raw_source_ids.contains(source.source_id.as_str())
            && !mentions
                .iter()
                .any(|item| item.source_id == source.source_id)
        {
            mentions.push(source);
        }
    }
    Ok(mentions)
}
