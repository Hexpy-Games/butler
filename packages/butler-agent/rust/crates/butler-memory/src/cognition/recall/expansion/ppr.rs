//! Personalized PageRank over the expanded recall graph.

use indexmap::IndexMap;

use super::{RecallEdge, is_navigation, is_positive};

const ALPHA: f64 = 0.2;
const PROPAGATION: f64 = 1.0 - ALPHA;
const EPSILON: f64 = 1e-6;

pub(super) fn personalized_page_rank(
    nodes: &[String],
    seeds: &[String],
    edges: &[RecallEdge],
) -> IndexMap<String, f64> {
    if nodes.is_empty() || seeds.is_empty() {
        return IndexMap::new();
    }
    let indexes = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.as_str(), index))
        .collect::<std::collections::HashMap<_, _>>();
    let distribution = seed_distribution(&indexes, seeds, nodes.len());
    let transitions = transitions(&indexes, edges, nodes.len());
    let mut scores = distribution.clone();
    let mut next = vec![0.0; nodes.len()];
    for _ in 0..32 {
        for (target, seed) in next.iter_mut().zip(&distribution) {
            *target = ALPHA * seed;
        }
        let mut dangling = 0.0;
        for (outgoing, &score) in transitions.iter().zip(&scores) {
            let total = outgoing.iter().map(|item| item.1).sum::<f64>();
            if total <= 0.0 {
                dangling += score;
                continue;
            }
            for &(target, weight) in outgoing {
                if let Some(slot) = next.get_mut(target) {
                    *slot += PROPAGATION * score * weight / total;
                }
            }
        }
        for seed in seeds {
            if let Some(&index) = indexes.get(seed.as_str())
                && let (Some(slot), Some(seed_weight)) =
                    (next.get_mut(index), distribution.get(index))
            {
                *slot += PROPAGATION * dangling * seed_weight;
            }
        }
        let delta = next
            .iter()
            .zip(&scores)
            .map(|(new, old)| (new - old).abs())
            .sum::<f64>();
        std::mem::swap(&mut scores, &mut next);
        if delta <= EPSILON {
            break;
        }
    }
    nodes.iter().cloned().zip(scores).collect()
}

type NodeIndexes<'a> = std::collections::HashMap<&'a str, usize>;

/// The restart distribution: each seed weighted by its reciprocal rank.
fn seed_distribution(indexes: &NodeIndexes<'_>, seeds: &[String], len: usize) -> Vec<f64> {
    let weights = seeds
        .iter()
        .enumerate()
        .map(|(index, _)| 1.0 / (60.0 + index as f64 + 1.0))
        .collect::<Vec<_>>();
    let weight_total = weights.iter().copied().sum::<f64>();
    // JavaScript Map preserves the first insertion slot but a duplicate seed
    // overwrites its distribution value with that seed's later weight.
    let mut distribution = vec![0.0; len];
    for (seed, weight) in seeds.iter().zip(weights) {
        if let Some(slot) = indexes
            .get(seed.as_str())
            .and_then(|index| distribution.get_mut(*index))
        {
            *slot = weight / weight_total;
        }
    }
    distribution
}

/// Weighted outgoing edges per node; reverse edges are damped unless the
/// relation is symmetric.
fn transitions(
    indexes: &NodeIndexes<'_>,
    edges: &[RecallEdge],
    len: usize,
) -> Vec<Vec<(usize, f64)>> {
    let mut transitions = vec![Vec::<(usize, f64)>::new(); len];
    for edge in edges {
        let (Some(&source), Some(&target)) = (
            indexes.get(edge.source_node_id.as_str()),
            indexes.get(edge.target_node_id.as_str()),
        ) else {
            continue;
        };
        if !is_positive(&edge.relation) {
            continue;
        }
        let support = edge.support.ln_1p();
        let factor = if is_navigation(&edge.relation) {
            0.25
        } else {
            1.0
        };
        if let Some(outgoing) = transitions.get_mut(source) {
            outgoing.push((target, support * factor));
        }
        let reverse = if edge.relation == "related_to" || edge.relation == "co_occurred" {
            1.0
        } else {
            0.5
        };
        if let Some(incoming) = transitions.get_mut(target) {
            incoming.push((source, support * factor * reverse));
        }
    }
    transitions
}
