//! Identity-aware semantic/temporal expansion and source mention composition.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::{
    CognitionResult,
    graph::{CurrentVectorMatches, GraphRecallReader, RawSourceSelection, RecallMention},
    recall::{
        EligibleAdjacency, GraphExpansion, IdentityMembers, IdentityReadScope, RecallRequest,
        SemanticSelection,
    },
    sources::identity_binding_current,
};
use crate::conversation::ConversationSourceReader;

pub(super) struct SeedGraph {
    pub expansion: GraphExpansion,
    pub selected: SemanticSelection,
    pub temporal_episode_ids: Vec<String>,
    pub vector_episodes: Vec<crate::cognition::recall::RecallVectorMatch>,
    pub vector_searched: bool,
    pub mentions: Vec<RecallMention>,
    pub raw_episode_ids: HashSet<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn expand(
    graph: &GraphRecallReader,
    canonical: Option<&ConversationSourceReader>,
    data_root: &Path,
    memory_root: &Path,
    input: &RecallRequest,
    mut selected: SemanticSelection,
    temporal: crate::cognition::graph::TemporalSelection,
    raw: &RawSourceSelection,
    vector: Option<&CurrentVectorMatches>,
    graph_deadline: i64,
    now_millis: &dyn Fn() -> i64,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<SeedGraph> {
    let admitted = input.admitted_channels.clone().unwrap_or_default();
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
    let vector_episodes = vector.map_or_else(Vec::new, |current| current.episodes.clone());
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
    let mut source_current = |binding: &crate::cognition::recall::IdentitySourceBinding| {
        let Ok(rows) = graph.source_rows(std::slice::from_ref(&binding.source_ref)) else {
            return false;
        };
        let Ok(Some(episode)) = graph.episode_identity(&binding.episode_id) else {
            return false;
        };
        rows.iter().any(|row| {
            identity_binding_current(data_root, memory_root, canonical, row, binding, &episode)
        })
    };
    let mut resolved = Vec::new();
    let mut dedup = HashSet::new();
    for seed in &selected.seeds {
        let result =
            graph.resolve_identity(seed, &scope, parse_date, &mut source_current, &mut || {
                now_millis()
            })?;
        if result.partial {
            selected.coverage_codes.push("identity_partial".into());
        }
        if dedup.insert(result.node_id.clone()) {
            resolved.push(result.node_id);
        }
    }
    let mut adjacency_cache =
        HashMap::<(String, usize, usize), (Vec<crate::cognition::recall::RecallEdge>, bool)>::new();
    let mut members = |node: &str, limit: usize| {
        let result = graph.identity_members(
            node,
            &scope,
            limit,
            parse_date,
            &mut source_current,
            &mut || now_millis(),
        )?;
        Ok::<_, crate::cognition::CognitionError>(IdentityMembers {
            members: result.members,
            partial: result.partial,
        })
    };
    let expansion = crate::cognition::recall::expand_graph(
        &resolved,
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
            Ok::<_, crate::cognition::CognitionError>(page)
        },
        graph_deadline,
        now_millis,
        Some(&mut members),
    )?;
    let reachable = expansion.paths.keys().cloned().collect::<Vec<_>>();
    let mut mentions = graph.mentions_for_nodes(input, &reachable)?;
    let direct = graph.mentions_for_episodes(input, &direct_episode_ids)?;
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
    Ok(SeedGraph {
        expansion,
        selected,
        temporal_episode_ids: temporal.episode_ids,
        vector_episodes,
        vector_searched: vector.is_some(),
        mentions,
        raw_episode_ids,
    })
}
