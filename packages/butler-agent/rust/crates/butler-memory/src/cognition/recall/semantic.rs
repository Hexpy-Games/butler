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

/// How semantic seeds are chosen from the ranked channels.
#[derive(Clone, Copy)]
pub(in crate::cognition) struct SeedOptions {
    /// Seeds kept before any time filter.
    pub max_seeds: usize,
    /// A time window applies, so at most eight seeds are used.
    pub time_bounded: bool,
    /// Only the context lane was admitted.
    pub context_only: bool,
    /// The lexical lane stopped early.
    pub lexical_partial: bool,
}

/// Fuses the ranked channels into seeds by weighted reciprocal rank (the
/// context lane alone when no other lane was admitted).
pub(in crate::cognition) fn select_semantic_seeds(
    channels: impl IntoIterator<Item = RankedCandidate>,
    options: SeedOptions,
) -> SemanticSelection {
    let by_node = best_per_channel(channels, options.context_only);
    let all_seeds = fused_order(&by_node, options.context_only)
        .into_iter()
        .take(options.max_seeds)
        .collect::<Vec<_>>();
    let seeds = all_seeds
        .iter()
        .take(if options.time_bounded {
            8
        } else {
            options.max_seeds
        })
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
        coverage_codes: if options.lexical_partial {
            vec!["lexical_partial".into()]
        } else {
            Vec::new()
        },
    }
}

/// Each node's best candidate per channel. Unless only the context lane was
/// admitted, context candidates only join nodes another lane found.
fn best_per_channel(
    channels: impl IntoIterator<Item = RankedCandidate>,
    context_only: bool,
) -> HashMap<String, HashMap<Channel, RankedCandidate>> {
    let mut by_node = HashMap::<String, HashMap<Channel, RankedCandidate>>::new();
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
    by_node
}

/// Node ids by fused score, then context rank, then id.
fn fused_order(
    by_node: &HashMap<String, HashMap<Channel, RankedCandidate>>,
    context_only: bool,
) -> Vec<String> {
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
    ranked.into_iter().map(|row| row.0).collect()
}
