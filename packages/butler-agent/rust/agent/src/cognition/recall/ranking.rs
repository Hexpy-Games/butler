//! Pure episode candidate fusion and ranking, retaining source ordering.

use std::collections::HashSet;

use super::contracts::{
    EpisodeRankInput, ExecutedEpisodeChannels, FusedEpisodeCandidates, RankedEpisode,
    RecallResultChannel, Salience, TimeBasis,
};

pub(in crate::cognition) fn fuse_episode_candidates(
    graph: &[String],
    vector: &[String],
    lexical: &[String],
    context: &[String],
) -> FusedEpisodeCandidates {
    let queues = [graph, vector, lexical, context];
    let lengths = queues.map(|queue| queue.len().min(128));
    let mut offsets = [0usize; 4];
    let mut seen = HashSet::new();
    let mut episode_ids = Vec::new();
    while episode_ids.len() < 128 && (0..4).any(|index| offsets[index] < lengths[index]) {
        for index in 0..4 {
            if episode_ids.len() == 128 {
                break;
            }
            let offset = offsets[index];
            offsets[index] += 1;
            if offset < lengths[index] && seen.insert(queues[index][offset].as_str()) {
                episode_ids.push(queues[index][offset].clone());
            }
        }
    }
    let candidate_limit = (0..4).any(|index| offsets[index] < lengths[index]);
    FusedEpisodeCandidates {
        episode_ids,
        candidate_limit,
    }
}

pub(in crate::cognition) fn rank_episodes(
    values: Vec<EpisodeRankInput>,
    executed: ExecutedEpisodeChannels,
    as_of: &str,
    time_basis: TimeBasis,
    parse_date: &dyn Fn(&str) -> f64,
) -> Vec<RankedEpisode> {
    let denominator = (if executed.graph { 1.0 / 61.0 } else { 0.0 })
        + (if executed.vector { 1.0 / 61.0 } else { 0.0 })
        + (if executed.lexical { 0.5 / 61.0 } else { 0.0 })
        + (if executed.context { 0.5 / 61.0 } else { 0.0 });
    let denominator = if denominator == 0.0 { 1.0 } else { denominator };
    let as_of_ms = parse_date(as_of);
    let mut ranked: Vec<_> = values
        .into_iter()
        .map(|input| {
            let mut channels = Vec::with_capacity(4);
            for (rank, channel) in [
                (input.graph_rank, RecallResultChannel::Graph),
                (input.vector_rank, RecallResultChannel::Vector),
                (input.lexical_rank, RecallResultChannel::Lexical),
                (input.context_rank, RecallResultChannel::Context),
            ] {
                if rank.is_some() {
                    channels.push(channel);
                }
            }
            let fused = (rrf(input.graph_rank)
                + rrf(input.vector_rank)
                + 0.5 * rrf(input.lexical_rank)
                + 0.5 * rrf(input.context_rank))
                / denominator;
            let salience = match input.salience {
                Some(Salience::High) => 1.0,
                Some(Salience::Normal) => 0.5,
                _ => 0.0,
            };
            let basis = match time_basis {
                TimeBasis::Conversation => input.conversation_at.as_deref(),
                TimeBasis::Event => input.event_at.as_deref(),
            };
            let age_days = match basis.filter(|value| !value.is_empty()) {
                Some(value) => js_max(0.0, (as_of_ms - parse_date(value)) / 86_400_000.0),
                None => f64::INFINITY,
            };
            let recency = if age_days.is_finite() {
                2.0f64.powf(-age_days / input.half_life_days.unwrap_or(30.0))
            } else {
                0.0
            };
            let support = js_min(
                1.0,
                input.support_count.unwrap_or(0.0).ln_1p() / 17.0f64.ln(),
            );
            let metadata = 0.5 * salience + 0.3 * recency + 0.2 * support;
            let score = match input.query_relevance {
                None => 0.8 * fused + 0.2 * metadata,
                Some(relevance) => {
                    0.55 * js_min(1.0, js_max(0.0, relevance)) + 0.35 * fused + 0.1 * metadata
                }
            };
            RankedEpisode {
                input,
                score,
                channels,
            }
        })
        .collect();
    ranked.sort_by(|a, b| {
        descending_subtract(a.score, b.score)
            .then_with(|| priority_compare(a.input.explicit_priority, b.input.explicit_priority))
            .then_with(|| {
                let (a_time, b_time) = match time_basis {
                    TimeBasis::Conversation => (
                        a.input.conversation_at.as_deref(),
                        b.input.conversation_at.as_deref(),
                    ),
                    TimeBasis::Event => (a.input.event_at.as_deref(), b.input.event_at.as_deref()),
                };
                compare_nullable_time(b_time, a_time)
            })
            .then_with(|| {
                a.input
                    .episode_id
                    .as_bytes()
                    .cmp(b.input.episode_id.as_bytes())
            })
    });
    ranked
}

pub(in crate::cognition) fn diversify_by_session(
    values: Vec<RankedEpisode>,
    limit: usize,
) -> Vec<RankedEpisode> {
    let mut selected = Vec::with_capacity(limit.min(values.len()));
    let mut sessions = HashSet::new();
    let mut groups = values.into_iter().peekable();
    while let Some(head) = groups.next() {
        if selected.len() == limit {
            break;
        }
        let score = head.score;
        let priority = head.input.explicit_priority.unwrap_or(false);
        let mut remaining = vec![head];
        while groups.peek().is_some_and(|value| {
            value.score == score && value.input.explicit_priority.unwrap_or(false) == priority
        }) {
            remaining.push(groups.next().expect("peeked value"));
        }
        while !remaining.is_empty() && selected.len() < limit {
            let unseen = remaining
                .iter()
                .position(|value| !sessions.contains(&value.input.session_id))
                .unwrap_or(0);
            let value = remaining.remove(unseen);
            sessions.insert(value.input.session_id.clone());
            selected.push(value);
        }
    }
    selected
}

fn rrf(rank: Option<f64>) -> f64 {
    rank.map_or(0.0, |value| 1.0 / (60.0 + value))
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn descending_subtract(a: f64, b: f64) -> std::cmp::Ordering {
    let difference = b - a;
    if difference > 0.0 {
        std::cmp::Ordering::Greater
    } else if difference < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Equal
    }
}

fn priority_compare(a: Option<bool>, b: Option<bool>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(a), Some(b)) => b.cmp(&a),
        _ => std::cmp::Ordering::Equal,
    }
}

fn compare_nullable_time(a: Option<&str>, b: Option<&str>) -> std::cmp::Ordering {
    match (a, b) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()),
    }
}
