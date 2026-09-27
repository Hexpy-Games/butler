use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(in crate::cognition) enum Channel {
    Alias,
    Lexical,
    Vector,
    Context,
}
#[derive(Clone, Debug)]
pub(in crate::cognition) struct RankedCandidate {
    pub node_id: String,
    pub channel: Channel,
    pub rank: usize,
    pub score: f64,
}
#[derive(Clone, Debug)]
pub(in crate::cognition) struct SemanticSelection {
    pub all_seeds: Vec<String>,
    pub seeds: Vec<String>,
    pub ranks: HashMap<String, HashMap<Channel, usize>>,
    pub scores: HashMap<String, HashMap<Channel, f64>>,
    pub coverage_codes: Vec<String>,
}

pub(in crate::cognition) fn rank_aliases(priorities: HashMap<String, i64>) -> Vec<RankedCandidate> {
    let mut rows = priorities.into_iter().collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
    });
    rows.into_iter()
        .take(64)
        .enumerate()
        .map(|(i, (node_id, priority))| RankedCandidate {
            node_id,
            channel: Channel::Alias,
            rank: i + 1,
            score: (3 - priority) as f64,
        })
        .collect()
}

pub(in crate::cognition) fn rank_lexical(
    query: &[String],
    documents: impl IntoIterator<Item = (String, Vec<String>)>,
    corpus_size: usize,
    df: &HashMap<String, usize>,
) -> Vec<RankedCandidate> {
    if query.iter().any(|gram| !df.contains_key(gram)) {
        return Vec::new();
    }
    let idf = |gram: &str| {
        ((corpus_size as f64 + 1.0) / (df.get(gram).copied().unwrap_or(0) as f64 + 1.0) + 1.0).ln()
    };
    let query_norm = query.iter().map(|g| idf(g)).sum::<f64>();
    let query_set = query.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut scores = HashMap::<String, f64>::new();
    for (node_id, grams) in documents {
        if grams.iter().any(|g| !df.contains_key(g)) {
            continue;
        }
        let document_norm = grams.iter().map(|g| idf(g)).sum::<f64>();
        let matched = grams
            .iter()
            .filter(|g| query_set.contains(g.as_str()))
            .map(|g| idf(g))
            .sum::<f64>();
        let score = matched / (query_norm * document_norm).sqrt();
        if score.is_finite() {
            scores
                .entry(node_id)
                .and_modify(|s| *s = s.max(score))
                .or_insert(score);
        }
    }
    let mut rows = scores.into_iter().collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
    });
    rows.into_iter()
        .take(64)
        .enumerate()
        .map(|(i, (node_id, score))| RankedCandidate {
            node_id,
            channel: Channel::Lexical,
            rank: i + 1,
            score,
        })
        .collect()
}

pub(in crate::cognition) fn select_semantic_seeds(
    channels: impl IntoIterator<Item = RankedCandidate>,
    lexical_partial: bool,
    max_seeds: usize,
    has_time: bool,
    admitted_noncontext: bool,
) -> SemanticSelection {
    let mut by_node = HashMap::<String, HashMap<Channel, RankedCandidate>>::new();
    let context_only = !admitted_noncontext;
    for candidate in channels {
        if candidate.channel == Channel::Context
            && !context_only
            && !by_node.contains_key(&candidate.node_id)
        {
            continue;
        }
        let entry = by_node.entry(candidate.node_id.clone()).or_default();
        let prior = entry.get(&candidate.channel);
        if prior.is_none_or(|prior| {
            candidate.rank < prior.rank
                || candidate.rank == prior.rank && candidate.score > prior.score
        }) {
            entry.insert(candidate.channel, candidate);
        }
    }
    let mut ranked = by_node
        .iter()
        .map(|(node_id, channels)| {
            let rank = |channel: Channel| channels.get(&channel).map(|c| c.rank as f64);
            let score = if context_only {
                1.0 / (60.0 + rank(Channel::Context).unwrap_or(1.0))
            } else {
                rank(Channel::Alias).map_or(0.0, |r| 3.0 / (60.0 + r))
                    + rank(Channel::Lexical).map_or(0.0, |r| 1.0 / (60.0 + r))
                    + rank(Channel::Vector).map_or(0.0, |r| 2.0 / (60.0 + r))
            };
            (
                node_id.clone(),
                score,
                rank(Channel::Context).unwrap_or(f64::INFINITY),
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| a.2.total_cmp(&b.2))
            .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
    });
    let all_seeds = ranked
        .into_iter()
        .take(max_seeds)
        .map(|row| row.0)
        .collect::<Vec<_>>();
    let seeds = all_seeds
        .iter()
        .take(if has_time { 8 } else { max_seeds })
        .cloned()
        .collect();
    SemanticSelection {
        all_seeds,
        seeds,
        ranks: by_node
            .iter()
            .map(|(id, values)| {
                (
                    id.clone(),
                    values
                        .iter()
                        .map(|(channel, value)| (*channel, value.rank))
                        .collect(),
                )
            })
            .collect(),
        scores: by_node
            .iter()
            .map(|(id, values)| {
                (
                    id.clone(),
                    values
                        .iter()
                        .map(|(channel, value)| (*channel, value.score))
                        .collect(),
                )
            })
            .collect(),
        coverage_codes: if lexical_partial {
            vec!["lexical_partial".into()]
        } else {
            Vec::new()
        },
    }
}
