use std::collections::{HashMap, HashSet};

use super::{clamp01, js_max, js_min};
use crate::cognition::legacy_recall::types::{
    LegacyRecallCandidate, LegacyRecallContext, LegacyRecallCorpus,
};

pub(super) const UNKNOWN_TIMESTAMP_RECENCY_SCORE: f64 = 0.15;
const RECENCY_DECAY_WINDOW_DAYS: f64 = 30.0;
const FREQUENCY_NORMALIZATION_REFERENCE_COUNT: f64 = 8.0;
const GRAPH_ACTIVATION_HOPS: usize = 2;
const GRAPH_EDGE_WEIGHT_CAP: f64 = 2.0;
const GRAPH_FORWARD_SPREAD_FACTOR: f64 = 0.58;
const GRAPH_REVERSE_SPREAD_FACTOR: f64 = 0.45;
const HUB_PENALTY_FREE_DEGREE: f64 = 8.0;
const HUB_PENALTY_FULL_SCALE: f64 = 40.0;
const CONFLICTING_MEMORY_PENALTY: f64 = 0.4;

pub(super) struct ContextualRecallEvidence {
    pub terms: HashSet<String>,
    related_node_ids: HashSet<String>,
    provenance_needles: Vec<String>,
}

pub(super) fn contextual_recall_evidence(
    context: Option<&LegacyRecallContext>,
    corpus: &LegacyRecallCorpus,
) -> Option<ContextualRecallEvidence> {
    let context = context?;
    let context_text = [
        context.recent_context.as_deref(),
        context.active_task_summary.as_deref(),
        context.project_state.as_deref(),
    ]
    .into_iter()
    .filter(|value| {
        value.is_some_and(|text| !crate::public_text::trim_js_whitespace(text).is_empty())
    })
    .map(Option::unwrap)
    .chain(context.recent_artifacts.iter().map(String::as_str))
    .chain(context.recent_actions.iter().map(String::as_str))
    .collect::<Vec<_>>()
    .join("\n");
    let terms = super::lexical::lexical_tokens(&context_text)
        .into_iter()
        .collect::<HashSet<_>>();
    let related_node_ids = corpus
        .nodes
        .iter()
        .filter_map(|node| {
            let node_terms = super::lexical::lexical_tokens(&node.name);
            (!node_terms.is_empty() && node_terms.iter().any(|term| terms.contains(term)))
                .then(|| node.id.clone())
        })
        .collect::<HashSet<_>>();
    let mut provenance_needles = Vec::new();
    let mut seen = HashSet::new();
    if let Some(session_id) = context.session_id.as_deref() {
        for needle in super::lexical::lexical_tokens(session_id) {
            if seen.insert(needle.clone()) {
                provenance_needles.push(needle);
            }
        }
    }
    for artifact in &context.recent_artifacts {
        for needle in super::lexical::lexical_tokens(artifact) {
            if seen.insert(needle.clone()) {
                provenance_needles.push(needle);
            }
        }
    }
    if terms.is_empty() && related_node_ids.is_empty() && provenance_needles.is_empty() {
        return None;
    }
    Some(ContextualRecallEvidence {
        terms,
        related_node_ids,
        provenance_needles,
    })
}

pub(super) fn contextual_score(
    candidate: &LegacyRecallCandidate,
    evidence: Option<&ContextualRecallEvidence>,
) -> f64 {
    let explicit = clamp01(candidate.contextual_score.unwrap_or(0.0));
    let Some(evidence) = evidence else {
        return explicit;
    };
    let candidate_terms =
        super::lexical::lexical_tokens(&format!("{}\n{}", candidate.summary, candidate.text))
            .into_iter()
            .collect::<HashSet<_>>();
    let lexical_continuity = binary_cosine(&evidence.terms, &candidate_terms);
    let graph_continuity = if candidate.related_nodes.is_empty() {
        0.0
    } else {
        candidate
            .related_nodes
            .iter()
            .filter(|node| evidence.related_node_ids.contains(*node))
            .count() as f64
            / candidate.related_nodes.len() as f64
    };
    let provenance_continuity = evidence.provenance_needles.iter().any(|needle| {
        candidate.provenance.iter().any(|provenance| {
            super::lexical::lexical_tokens(provenance)
                .iter()
                .any(|term| term == needle)
        })
    });
    js_max(
        explicit,
        js_max(
            lexical_continuity,
            js_max(
                graph_continuity,
                if provenance_continuity { 1.0 } else { 0.0 },
            ),
        ),
    )
}

pub(super) fn build_degree_map(corpus: &LegacyRecallCorpus) -> HashMap<String, f64> {
    let mut degree = HashMap::new();
    for edge in &corpus.edges {
        *degree.entry(edge.source_id.clone()).or_insert(0.0) += 1.0;
        *degree.entry(edge.target_id.clone()).or_insert(0.0) += 1.0;
    }
    for node in &corpus.nodes {
        if let Some(value) = node.degree {
            degree.insert(node.id.clone(), value);
        }
    }
    degree
}

pub(super) fn activate_graph(
    corpus: &LegacyRecallCorpus,
    seeds: &[String],
) -> HashMap<String, f64> {
    let mut activation = HashMap::new();
    let degree = build_degree_map(corpus);
    for node in &corpus.nodes {
        let name = node.name.to_lowercase();
        if seeds
            .iter()
            .any(|seed| name.contains(seed) || seed.contains(&name))
        {
            activation.insert(node.id.clone(), 1.0);
        }
    }
    for _ in 0..GRAPH_ACTIVATION_HOPS {
        let mut next = activation.clone();
        for edge in &corpus.edges {
            let weight = edge.weight.unwrap_or(1.0);
            let capped_weight = js_min(GRAPH_EDGE_WEIGHT_CAP, weight);
            let spread = GRAPH_FORWARD_SPREAD_FACTOR * capped_weight
                / (1.0 + degree.get(&edge.source_id).copied().unwrap_or(0.0));
            let reverse_spread = GRAPH_REVERSE_SPREAD_FACTOR * capped_weight
                / (1.0 + degree.get(&edge.target_id).copied().unwrap_or(0.0));
            let source_activation = activation.get(&edge.source_id).copied().unwrap_or(0.0);
            let target_activation = activation.get(&edge.target_id).copied().unwrap_or(0.0);
            if source_activation > 0.0 {
                let value = js_max(
                    next.get(&edge.target_id).copied().unwrap_or(0.0),
                    source_activation * spread,
                );
                next.insert(edge.target_id.clone(), value);
            }
            if target_activation > 0.0 {
                let value = js_max(
                    next.get(&edge.source_id).copied().unwrap_or(0.0),
                    target_activation * reverse_spread,
                );
                next.insert(edge.source_id.clone(), value);
            }
        }
        activation = next;
    }
    activation
}

pub(super) fn candidate_graph_activation(
    candidate: &LegacyRecallCandidate,
    activation: &HashMap<String, f64>,
) -> f64 {
    candidate.related_nodes.iter().fold(0.0, |value, node| {
        js_max(value, activation.get(node).copied().unwrap_or(0.0))
    })
}

pub(super) fn candidate_hub_penalty(
    candidate: &LegacyRecallCandidate,
    degree: &HashMap<String, f64>,
) -> f64 {
    candidate.related_nodes.iter().fold(0.0, |value, node| {
        let node_penalty = js_min(
            1.0,
            js_max(
                0.0,
                (degree.get(node).copied().unwrap_or(0.0) - HUB_PENALTY_FREE_DEGREE)
                    / HUB_PENALTY_FULL_SCALE,
            ),
        );
        js_max(value, node_penalty)
    })
}

pub(super) fn candidate_conflict_penalty(
    candidate: &LegacyRecallCandidate,
    active_candidate_ids: &HashSet<&str>,
) -> f64 {
    if candidate
        .contradicts
        .iter()
        .any(|id| active_candidate_ids.contains(id.as_str()))
    {
        CONFLICTING_MEMORY_PENALTY
    } else {
        0.0
    }
}

pub(super) fn explicit_evidence_score(candidate: &LegacyRecallCandidate, anchor_score: f64) -> f64 {
    let salience = candidate.explicit_salience.unwrap_or_else(|| {
        if candidate.source == super::super::types::LegacyRecallSource::Explicit {
            1.0
        } else {
            0.0
        }
    });
    if salience <= 0.0 || anchor_score <= 0.0 {
        return 0.0;
    }
    clamp01(salience * anchor_score)
}

pub(super) fn recency_score(timestamp: Option<f64>, now: f64) -> f64 {
    let Some(timestamp) = timestamp.filter(|value| *value != 0.0 && !value.is_nan()) else {
        return UNKNOWN_TIMESTAMP_RECENCY_SCORE;
    };
    let age_ms = js_max(0.0, now - timestamp * 1000.0);
    let window_ms = RECENCY_DECAY_WINDOW_DAYS * 24.0 * 60.0 * 60.0 * 1000.0;
    js_max(0.0, 1.0 - age_ms / window_ms)
}

pub(super) fn frequency_score(value: Option<f64>) -> f64 {
    js_min(
        1.0,
        value.unwrap_or(0.0).ln_1p() / FREQUENCY_NORMALIZATION_REFERENCE_COUNT.ln_1p(),
    )
}

fn binary_cosine(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let overlap = left.iter().filter(|token| right.contains(*token)).count();
    clamp01(overlap as f64 / ((left.len() * right.len()) as f64).sqrt())
}
