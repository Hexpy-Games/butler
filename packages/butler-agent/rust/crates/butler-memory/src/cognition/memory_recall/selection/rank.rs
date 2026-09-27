//! Source score channels, round-robin fusion, relationship-qualified ranking.
//!
//! [`rank`] scores every episode per channel (graph, lexical, context from
//! mentions; raw sources and temporal seeds add to lexical and context),
//! fuses the admitted channels into candidates, drops superseded rows, ranks
//! and diversifies them, and records per-candidate metrics.

use std::collections::{HashMap, HashSet};

use crate::cognition::{
    CognitionResult,
    graph::{
        GraphRecallReader, ProjectionCoverage, RawSourceSelection, RecallEpisodeRow, RecallMention,
        RelationshipState,
    },
    recall::{
        Channel, EpisodeRankInput, ExecutedEpisodeChannels, RankedEpisode, RecallAdmittedChannels,
        RecallRequest, RecallTimeBasis, Salience, TimeBasis, diversify_by_session,
        fuse_episode_candidates, rank_episodes,
    },
};

use super::{Selection, seeds::SeedGraph};
use crate::cognition::memory_recall::metrics;

/// Per-episode best score of each source channel.
#[derive(Default)]
struct ChannelScores {
    graph: HashMap<String, f64>,
    lexical: HashMap<String, f64>,
    context: HashMap<String, f64>,
}

/// What raw lexical sources add besides their lexical score.
#[derive(Default)]
struct RawSignals {
    relevance: HashMap<String, f64>,
    exact: HashSet<String>,
    source_ids: HashSet<String>,
}

/// Episode ids of each admitted channel, best first.
struct ChannelLists {
    graph: Vec<String>,
    lexical: Vec<String>,
    /// Lexical candidates fused even when the lexical channel itself is not
    /// admitted but explicit records are.
    lexical_fusion: Vec<String>,
    context: Vec<String>,
    vector: Vec<String>,
}

/// 1-based ranks of each channel list.
struct ChannelRanks {
    graph: HashMap<String, f64>,
    lexical: HashMap<String, f64>,
    context: HashMap<String, f64>,
    vector: HashMap<String, f64>,
}

/// Scores, fuses, ranks and diversifies the seeded episodes.
#[allow(clippy::too_many_arguments)]
pub(super) fn rank(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    mut seeds: SeedGraph,
    raw: RawSourceSelection,
    coverage: ProjectionCoverage,
    _overall_deadline: i64,
    now_iso: &str,
    _now_millis: &dyn Fn() -> i64,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<Selection> {
    let admitted = input.admitted_channels.clone().unwrap_or_default();
    let mentions = group_mentions(std::mem::take(&mut seeds.mentions));
    let mut scores = ChannelScores::from_mentions(graph, &mentions, &seeds)?;
    let raw = scores.merge_raw(raw, &seeds.temporal_episode_ids);
    let lists = ChannelLists::admitted(&scores, &admitted, &seeds);
    let fused = fuse_episode_candidates(
        &lists.graph,
        &lists.vector,
        &lists.lexical_fusion,
        &lists.context,
    );
    let rows = graph.episode_rows(input, &fused.episode_ids, &seeds.raw_episode_ids)?;
    let (usable, relationships) = current_rows(graph, input, rows, &seeds, now_iso)?;
    let ranks = ChannelRanks {
        graph: rank_map(&lists.graph),
        lexical: rank_map(&lists.lexical),
        context: rank_map(&lists.context),
        vector: rank_map(&lists.vector),
    };
    let executed = executed_channels(input, &admitted, &seeds);
    let inputs = usable
        .iter()
        .map(|row| rank_input(row, &admitted, &ranks, &raw, &seeds))
        .collect();
    let mut ranked = diversify_by_session(
        rank_episodes(
            inputs,
            executed,
            &input.as_of,
            time_basis(input),
            parse_date,
        ),
        128,
    );
    ranked.sort_by_key(|episode| !raw.exact.contains(&episode.input.episode_id));
    let metrics = candidate_metrics(&ranked, &ranks, &scores, &seeds);
    Ok(Selection {
        empty_search: seeds.selected.seeds.is_empty()
            && seeds.temporal_episode_ids.is_empty()
            && seeds.vector_episodes.is_empty()
            && seeds.raw_episode_ids.is_empty(),
        ranked,
        rows: usable
            .into_iter()
            .map(|row| (row.episode_id.clone(), row))
            .collect(),
        mentions,
        relationships,
        expansion: seeds.expansion,
        raw_source_ids: raw.source_ids,
        raw_episode_ids: seeds.raw_episode_ids,
        coverage,
        selection_codes: seeds.selected.coverage_codes,
        candidate_limit: fused.candidate_limit,
        vector_current: None,
        metrics,
        executed: metrics::Executed {
            graph: executed.graph,
            vector: executed.vector,
            lexical: executed.lexical,
            context: executed.context,
        },
    })
}

/// The admitted channels that actually ran: vector only when requested and
/// searched, lexical only when its scan completed.
fn executed_channels(
    input: &RecallRequest,
    admitted: &RecallAdmittedChannels,
    seeds: &SeedGraph,
) -> ExecutedEpisodeChannels {
    ExecutedEpisodeChannels {
        graph: admitted.graph,
        vector: admitted.vector && input.include_vector && seeds.vector_searched,
        lexical: admitted.lexical
            && !seeds
                .selected
                .coverage_codes
                .iter()
                .any(|code| code == "lexical_partial"),
        context: admitted.context,
    }
}

/// Event time when the request asks for it, else conversation time.
fn time_basis(input: &RecallRequest) -> TimeBasis {
    if input
        .time
        .as_ref()
        .is_some_and(|time| time.basis == RecallTimeBasis::Event)
    {
        TimeBasis::Event
    } else {
        TimeBasis::Conversation
    }
}

fn group_mentions(all: Vec<RecallMention>) -> HashMap<String, Vec<RecallMention>> {
    let mut mentions = HashMap::<String, Vec<RecallMention>>::new();
    for mention in all {
        mentions
            .entry(mention.episode_id.clone())
            .or_default()
            .push(mention);
    }
    mentions
}

impl ChannelScores {
    /// Per episode: graph relevance of its mentioned nodes (not supporting
    /// mentions of projects), and their best lexical and context seed scores.
    fn from_mentions(
        graph: &GraphRecallReader,
        mentions: &HashMap<String, Vec<RecallMention>>,
        seeds: &SeedGraph,
    ) -> CognitionResult<Self> {
        let mut scores = Self::default();
        let mut node_types = HashMap::<String, Option<String>>::new();
        for (episode_id, episode_mentions) in mentions {
            let mut graph_score = 0.0f64;
            let mut lexical_score = 0.0f64;
            let mut context_score = 0.0f64;
            for mention in episode_mentions {
                let kind = if let Some(value) = node_types.get(&mention.node_id) {
                    value.clone()
                } else {
                    let value = graph.node_type(&mention.node_id)?;
                    node_types.insert(mention.node_id.clone(), value.clone());
                    value
                };
                if !mention.supports && kind.as_deref() != Some("project") {
                    graph_score = graph_score.max(
                        *seeds
                            .expansion
                            .relevance
                            .get(&mention.node_id)
                            .unwrap_or(&0.0),
                    );
                }
                lexical_score = lexical_score.max(seed_score(seeds, &mention.node_id));
                context_score = context_score.max(context_seed_score(seeds, &mention.node_id));
            }
            scores.graph.insert(episode_id.clone(), graph_score);
            scores.lexical.insert(episode_id.clone(), lexical_score);
            scores.context.insert(episode_id.clone(), context_score);
        }
        Ok(scores)
    }

    /// Raw sources raise lexical scores (and record relevance and exact
    /// matches); temporal seeds raise context scores by their order.
    fn merge_raw(&mut self, raw: RawSourceSelection, temporal: &[String]) -> RawSignals {
        let mut signals = RawSignals::default();
        for source in raw.sources {
            signals.source_ids.insert(source.source_id);
            let prior = signals
                .relevance
                .entry(source.episode_id.clone())
                .or_insert(0.0);
            *prior = prior.max(source.score);
            raise(&mut self.lexical, &source.episode_id, source.score);
            if source.exact_match {
                signals.exact.insert(source.episode_id);
            }
        }
        for (index, episode_id) in temporal.iter().enumerate() {
            raise(&mut self.context, episode_id, 1.0 / (index + 1) as f64);
        }
        signals
    }
}

fn seed_score(seeds: &SeedGraph, node_id: &str) -> f64 {
    seeds
        .selected
        .scores
        .get(node_id)
        .and_then(|channels| channels.get(&Channel::Lexical))
        .copied()
        .unwrap_or(0.0)
}

fn context_seed_score(seeds: &SeedGraph, node_id: &str) -> f64 {
    seeds
        .selected
        .ranks
        .get(node_id)
        .and_then(|channels| channels.get(&Channel::Context))
        .copied()
        .map_or(0.0, |rank| 1.0 / rank as f64)
}

fn raise(scores: &mut HashMap<String, f64>, episode_id: &str, score: f64) {
    scores
        .entry(episode_id.to_owned())
        .and_modify(|value| *value = value.max(score))
        .or_insert(score);
}

impl ChannelLists {
    fn admitted(
        scores: &ChannelScores,
        admitted: &RecallAdmittedChannels,
        seeds: &SeedGraph,
    ) -> Self {
        let when = |on: bool, ids: Vec<String>| if on { ids } else { Vec::new() };
        let lexical_candidates = ranked_ids(&scores.lexical);
        let lexical = when(admitted.lexical, lexical_candidates.clone());
        let lexical_fusion = if admitted.explicit && !admitted.lexical {
            lexical_candidates
        } else {
            lexical.clone()
        };
        Self {
            graph: when(admitted.graph, ranked_ids(&scores.graph)),
            lexical,
            lexical_fusion,
            context: when(admitted.context, ranked_ids(&scores.context)),
            vector: when(
                admitted.vector,
                seeds
                    .vector_episodes
                    .iter()
                    .map(|hit| hit.owner_id.clone())
                    .collect(),
            ),
        }
    }
}

/// Fused rows that are not superseded (unless a raw source asked for them),
/// with their relationship priority and support count.
fn current_rows(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    rows: Vec<RecallEpisodeRow>,
    seeds: &SeedGraph,
    now_iso: &str,
) -> CognitionResult<(Vec<RecallEpisodeRow>, HashMap<String, RelationshipState>)> {
    let mut relationships = HashMap::<String, RelationshipState>::new();
    let mut usable = Vec::<RecallEpisodeRow>::new();
    for mut row in rows {
        let relation = graph.relationship_state(input, &row.episode_id, now_iso)?;
        if relation.superseded && !seeds.raw_episode_ids.contains(&row.episode_id) {
            continue;
        }
        row.explicit_priority = relation.explicit_priority;
        row.support_count = graph.support_count(input, &row.episode_id)?;
        relationships.insert(row.episode_id.clone(), relation);
        usable.push(row);
    }
    Ok((usable, relationships))
}

fn rank_input(
    row: &RecallEpisodeRow,
    admitted: &RecallAdmittedChannels,
    ranks: &ChannelRanks,
    raw: &RawSignals,
    seeds: &SeedGraph,
) -> EpisodeRankInput {
    let rank = |on: bool, map: &HashMap<String, f64>| {
        if on {
            map.get(&row.episode_id).copied()
        } else {
            None
        }
    };
    EpisodeRankInput {
        episode_id: row.episode_id.clone(),
        session_id: row.session_id.clone(),
        conversation_at: row.conversation_at.clone(),
        event_at: row.event_at.clone(),
        graph_rank: rank(admitted.graph, &ranks.graph),
        lexical_rank: rank(admitted.lexical, &ranks.lexical),
        context_rank: rank(admitted.context, &ranks.context),
        vector_rank: rank(admitted.vector, &ranks.vector),
        query_relevance: Some(
            seeds
                .vector_episodes
                .iter()
                .filter(|hit| admitted.vector && hit.owner_id == row.episode_id)
                .map(|hit| 1.0 - hit.distance)
                .fold(
                    *raw.relevance.get(&row.episode_id).unwrap_or(&0.0),
                    f64::max,
                ),
        ),
        explicit_priority: Some(admitted.explicit && row.explicit_priority),
        salience: Some(Salience::from_stored(&row.salience)),
        support_count: Some(row.support_count),
        half_life_days: Some(row.half_life_days),
    }
}

fn candidate_metrics(
    ranked: &[RankedEpisode],
    ranks: &ChannelRanks,
    scores: &ChannelScores,
    seeds: &SeedGraph,
) -> Vec<metrics::Candidate> {
    let vector_distances = seeds
        .vector_episodes
        .iter()
        .map(|hit| (hit.owner_id.as_str(), hit.distance))
        .collect::<HashMap<_, _>>();
    let at = |map: &HashMap<String, f64>, id: &String| map.get(id).copied().unwrap_or(0.0);
    ranked
        .iter()
        .map(|episode| {
            let id = &episode.input.episode_id;
            metrics::Candidate {
                episode_id: id.clone(),
                candidate_score: episode.score,
                g_rank: at(&ranks.graph, id),
                g_score: at(&scores.graph, id),
                v_rank: at(&ranks.vector, id),
                v_ann_distance: vector_distances.get(id.as_str()).copied(),
                l_rank: at(&ranks.lexical, id),
                l_score: at(&scores.lexical, id),
                c_rank: at(&ranks.context, id),
                c_score: at(&scores.context, id),
            }
        })
        .collect()
}

fn ranked_ids(scores: &HashMap<String, f64>) -> Vec<String> {
    let mut rows = scores
        .iter()
        .filter(|(_, score)| **score > 0.0)
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.1.total_cmp(a.1)
            .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
    });
    rows.into_iter()
        .take(128)
        .map(|(id, _)| id.clone())
        .collect()
}
fn rank_map(ids: &[String]) -> HashMap<String, f64> {
    ids.iter()
        .enumerate()
        .map(|(index, id)| (id.clone(), (index + 1) as f64))
        .collect()
}
