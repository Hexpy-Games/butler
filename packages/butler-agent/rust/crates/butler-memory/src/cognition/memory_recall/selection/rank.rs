//! Source score channels, round-robin fusion, relationship-qualified ranking.

use std::collections::{HashMap, HashSet};

use crate::cognition::{
    CognitionResult,
    graph::{
        GraphRecallReader, ProjectionCoverage, RawSourceSelection, RecallEpisodeRow, RecallMention,
        RelationshipState,
    },
    recall::{
        Channel, EpisodeRankInput, ExecutedEpisodeChannels, RecallRequest, Salience, TimeBasis,
        diversify_by_session, fuse_episode_candidates, rank_episodes,
    },
};

use super::{Selection, seeds::SeedGraph};
use crate::cognition::memory_recall::metrics;

#[allow(clippy::too_many_arguments)]
pub(super) fn rank(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    seeds: SeedGraph,
    raw: RawSourceSelection,
    coverage: ProjectionCoverage,
    _overall_deadline: i64,
    now_iso: &str,
    _now_millis: &dyn Fn() -> i64,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<Selection> {
    let admitted = input.admitted_channels.clone().unwrap_or_default();
    let mut mentions = HashMap::<String, Vec<RecallMention>>::new();
    for mention in seeds.mentions {
        mentions
            .entry(mention.episode_id.clone())
            .or_default()
            .push(mention);
    }
    let mut node_types = HashMap::<String, Option<String>>::new();
    let mut graph_scores = HashMap::<String, f64>::new();
    let mut lexical_scores = HashMap::<String, f64>::new();
    let mut context_scores = HashMap::<String, f64>::new();
    for (episode_id, episode_mentions) in &mentions {
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
            lexical_score = lexical_score.max(
                seeds
                    .selected
                    .scores
                    .get(&mention.node_id)
                    .and_then(|channels| channels.get(&Channel::Lexical))
                    .copied()
                    .unwrap_or(0.0),
            );
            let context_rank = seeds
                .selected
                .ranks
                .get(&mention.node_id)
                .and_then(|channels| channels.get(&Channel::Context))
                .copied();
            context_score = context_score.max(context_rank.map_or(0.0, |rank| 1.0 / rank as f64));
        }
        graph_scores.insert(episode_id.clone(), graph_score);
        lexical_scores.insert(episode_id.clone(), lexical_score);
        context_scores.insert(episode_id.clone(), context_score);
    }
    let mut raw_relevance = HashMap::<String, f64>::new();
    let mut exact_raw = HashSet::new();
    let mut raw_source_ids = HashSet::new();
    for source in raw.sources {
        raw_source_ids.insert(source.source_id);
        let prior = raw_relevance
            .entry(source.episode_id.clone())
            .or_insert(0.0);
        *prior = prior.max(source.score);
        lexical_scores
            .entry(source.episode_id.clone())
            .and_modify(|score| *score = score.max(source.score))
            .or_insert(source.score);
        if source.exact_match {
            exact_raw.insert(source.episode_id);
        }
    }
    for (index, episode_id) in seeds.temporal_episode_ids.iter().enumerate() {
        let score = 1.0 / (index + 1) as f64;
        context_scores
            .entry(episode_id.clone())
            .and_modify(|value| *value = value.max(score))
            .or_insert(score);
    }
    let graph_list = if admitted.graph {
        ranked_ids(&graph_scores)
    } else {
        vec![]
    };
    let lexical_candidates = ranked_ids(&lexical_scores);
    let lexical_list = if admitted.lexical {
        lexical_candidates.clone()
    } else {
        vec![]
    };
    let context_list = if admitted.context {
        ranked_ids(&context_scores)
    } else {
        vec![]
    };
    let lexical_fusion = if admitted.explicit && !admitted.lexical {
        &lexical_candidates
    } else {
        &lexical_list
    };
    let vector_list = if admitted.vector {
        seeds
            .vector_episodes
            .iter()
            .map(|hit| hit.owner_id.clone())
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let fused = fuse_episode_candidates(&graph_list, &vector_list, lexical_fusion, &context_list);
    let rows = graph.episode_rows(input, &fused.episode_ids, &seeds.raw_episode_ids)?;
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
    let graph_ranks = rank_map(&graph_list);
    let lexical_ranks = rank_map(&lexical_list);
    let context_ranks = rank_map(&context_list);
    let vector_ranks = rank_map(&vector_list);
    let executed = ExecutedEpisodeChannels {
        graph: admitted.graph,
        vector: admitted.vector && input.include_vector && seeds.vector_searched,
        lexical: admitted.lexical
            && !seeds
                .selected
                .coverage_codes
                .iter()
                .any(|code| code == "lexical_partial"),
        context: admitted.context,
    };
    let inputs = usable
        .iter()
        .map(|row| EpisodeRankInput {
            episode_id: row.episode_id.clone(),
            session_id: row.session_id.clone(),
            conversation_at: row.conversation_at.clone(),
            event_at: row.event_at.clone(),
            graph_rank: if admitted.graph {
                graph_ranks.get(&row.episode_id).copied()
            } else {
                None
            },
            lexical_rank: if admitted.lexical {
                lexical_ranks.get(&row.episode_id).copied()
            } else {
                None
            },
            context_rank: if admitted.context {
                context_ranks.get(&row.episode_id).copied()
            } else {
                None
            },
            vector_rank: if admitted.vector {
                vector_ranks.get(&row.episode_id).copied()
            } else {
                None
            },
            query_relevance: Some(
                seeds
                    .vector_episodes
                    .iter()
                    .filter(|hit| admitted.vector && hit.owner_id == row.episode_id)
                    .map(|hit| 1.0 - hit.distance)
                    .fold(
                        *raw_relevance.get(&row.episode_id).unwrap_or(&0.0),
                        f64::max,
                    ),
            ),
            explicit_priority: Some(admitted.explicit && row.explicit_priority),
            salience: Some(match row.salience.as_str() {
                "high" => Salience::High,
                "normal" => Salience::Normal,
                _ => Salience::Unspecified,
            }),
            support_count: Some(row.support_count),
            half_life_days: Some(row.half_life_days),
        })
        .collect();
    let basis = if input
        .time
        .as_ref()
        .is_some_and(|time| time.basis == crate::cognition::recall::RecallTimeBasis::Event)
    {
        TimeBasis::Event
    } else {
        TimeBasis::Conversation
    };
    let mut ranked = diversify_by_session(
        rank_episodes(inputs, executed, &input.as_of, basis, parse_date),
        128,
    );
    ranked.sort_by_key(|episode| !exact_raw.contains(&episode.input.episode_id));
    let vector_distances = seeds
        .vector_episodes
        .iter()
        .map(|hit| (hit.owner_id.as_str(), hit.distance))
        .collect::<HashMap<_, _>>();
    let metrics = ranked
        .iter()
        .map(|episode| {
            let id = &episode.input.episode_id;
            metrics::Candidate {
                episode_id: id.clone(),
                candidate_score: episode.score,
                g_rank: graph_ranks.get(id).copied().unwrap_or(0.0),
                g_score: graph_scores.get(id).copied().unwrap_or(0.0),
                v_rank: vector_ranks.get(id).copied().unwrap_or(0.0),
                v_ann_distance: vector_distances.get(id.as_str()).copied(),
                l_rank: lexical_ranks.get(id).copied().unwrap_or(0.0),
                l_score: lexical_scores.get(id).copied().unwrap_or(0.0),
                c_rank: context_ranks.get(id).copied().unwrap_or(0.0),
                c_score: context_scores.get(id).copied().unwrap_or(0.0),
            }
        })
        .collect();
    let rows = usable
        .into_iter()
        .map(|row| (row.episode_id.clone(), row))
        .collect();
    Ok(Selection {
        empty_search: seeds.selected.seeds.is_empty()
            && seeds.temporal_episode_ids.is_empty()
            && seeds.vector_episodes.is_empty()
            && seeds.raw_episode_ids.is_empty(),
        ranked,
        rows,
        mentions,
        relationships,
        expansion: seeds.expansion,
        raw_source_ids,
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
