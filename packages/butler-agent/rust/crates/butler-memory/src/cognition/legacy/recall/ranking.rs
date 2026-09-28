//! Pure source-compatible scoring and evidence gating for one recall call.

mod evidence;
mod graph;
mod lexical;
mod selection;

use std::collections::{HashMap, HashSet};

use super::types::{
    LegacyRecallCandidate, LegacyRecallCorpus, LegacyRecallItem, LegacyRecallRequest,
    LegacyRecallResponse, LegacyRecallScoreBreakdown, LegacyRecallSource,
};
use evidence::{ActivePolicy, verify_evidence};
use graph::{
    activate_graph, build_degree_map, candidate_conflict_penalty, candidate_graph_activation,
    candidate_hub_penalty, contextual_recall_evidence, contextual_score, explicit_evidence_score,
    frequency_score, recency_score,
};
use lexical::{build_lexical_stats, extract_recall_seeds, lexical_score};
use selection::{ScoredCandidate, select_scored_candidates};

const DEFAULT_LIMIT: f64 = 5.0;
const DEFAULT_MIN_RECALL_SCORE: f64 = 0.01;
const VECTOR_SEMANTIC_NEIGHBORHOOD_MARGIN: f64 = 0.03;

#[derive(Clone, Copy, Debug, Default)]
struct RankingSignals {
    semantic: f64,
    lexical: f64,
    contextual: f64,
    graph: f64,
    recency: f64,
    frequency: f64,
    explicit: f64,
    boost: f64,
    hub: f64,
    conflict: f64,
    superseded: f64,
}

pub(super) fn recall_from_corpus(
    request: &LegacyRecallRequest,
    corpus: &LegacyRecallCorpus,
    now: f64,
) -> LegacyRecallResponse {
    let cue = butler_core::public_text::trim_js_whitespace(&request.cue).to_owned();
    let seeds = extract_recall_seeds(&cue);
    let limit = normalized_limit(request.limit);
    let scoring = Scoring::new(request, corpus, &seeds);
    let effective_policy = request
        .ranking_policy
        .as_ref()
        .or(request.evidence_policy.as_ref());
    let policy = ActivePolicy::from(effective_policy);
    let mut scored = corpus
        .candidates
        .iter()
        .map(|candidate| scoring.score(candidate, &policy, now))
        .filter(|item| item.breakdown.evidence_confidence > 0.0)
        .filter(|item| item.breakdown.total > 0.0)
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| compare_scored(left, right, &policy));

    let min_score = request.min_score.unwrap_or(DEFAULT_MIN_RECALL_SCORE);
    let planned_evidence_limit = if policy.planned {
        limit.max(policy.non_exact_evidence_count())
    } else {
        limit
    };
    let score_selection =
        select_scored_candidates(&scored, min_score, planned_evidence_limit, &policy);
    let raw_items = score_selection
        .items
        .iter()
        .filter_map(|index| scored.get(*index))
        .map(|item| recall_item(item.candidate, &item.breakdown))
        .collect::<Vec<_>>();
    let contextual_candidates = raw_items
        .iter()
        .filter(|item| item.score_breakdown.contextual_match > 0.0)
        .count();
    let verification = verify_evidence(raw_items, effective_policy);
    let items = verification.items;
    let abstained = items.is_empty();
    let mut diagnostics = scoring.diagnostics(corpus, &policy, score_selection.diagnostic);
    diagnostics.push(format!("contextual_candidates={contextual_candidates}"));
    diagnostics.extend(verification.diagnostics);
    diagnostics.push(if abstained {
        "abstained=low-confidence".to_owned()
    } else {
        "abstained=false".to_owned()
    });

    LegacyRecallResponse {
        cue,
        seeds,
        items,
        abstained,
        diagnostics,
    }
}

/// What every candidate of one recall call is scored against.
struct Scoring<'a> {
    activation: HashMap<String, f64>,
    lexical_stats: lexical::LexicalStats,
    contextual_evidence: Option<graph::ContextualRecallEvidence>,
    degree: HashMap<String, f64>,
    active_candidate_ids: HashSet<&'a str>,
}

impl<'a> Scoring<'a> {
    fn new(
        request: &LegacyRecallRequest,
        corpus: &'a LegacyRecallCorpus,
        seeds: &[String],
    ) -> Self {
        Self {
            activation: activate_graph(corpus, seeds),
            lexical_stats: build_lexical_stats(&corpus.candidates, seeds),
            contextual_evidence: contextual_recall_evidence(request.context.as_ref(), corpus),
            degree: build_degree_map(corpus),
            active_candidate_ids: corpus
                .candidates
                .iter()
                .map(|candidate| candidate.id.as_str())
                .collect(),
        }
    }

    fn signals(&self, candidate: &LegacyRecallCandidate, now: f64) -> (RankingSignals, usize) {
        let semantic = semantic_score(candidate);
        let lexical = lexical_score(candidate, &self.lexical_stats);
        let contextual = contextual_score(candidate, self.contextual_evidence.as_ref());
        let explicit = explicit_evidence_score(
            candidate,
            js_max(semantic, js_max(lexical.score, contextual)),
        );
        let signals = RankingSignals {
            semantic,
            lexical: lexical.score,
            contextual,
            graph: candidate_graph_activation(candidate, &self.activation),
            recency: recency_score(candidate.timestamp, now),
            frequency: frequency_score(candidate.frequency),
            explicit,
            boost: 0.0,
            hub: candidate_hub_penalty(candidate, &self.degree),
            conflict: candidate_conflict_penalty(candidate, &self.active_candidate_ids),
            superseded: candidate
                .superseded_by
                .as_deref()
                .filter(|id| self.active_candidate_ids.contains(id))
                .map_or(0.0, |_| evidence::SUPERSEDED_MEMORY_PENALTY),
        };
        (signals, lexical.matched_seed_count)
    }

    fn score<'c>(
        &self,
        candidate: &'c LegacyRecallCandidate,
        policy: &ActivePolicy,
        now: f64,
    ) -> ScoredCandidate<'c> {
        let (signals, lexical_matched_seed_count) = self.signals(candidate, now);
        ScoredCandidate {
            candidate,
            lexical_matched_seed_count,
            breakdown: LegacyRecallScoreBreakdown {
                semantic_similarity: signals.semantic,
                lexical_match: signals.lexical,
                contextual_match: signals.contextual,
                graph_activation: signals.graph,
                recency_score: signals.recency,
                frequency_score: signals.frequency,
                explicit_salience: signals.explicit,
                evidence_confidence: evidence::evidence_confidence(candidate, signals, policy),
                decision_preference_boost: signals.boost,
                hub_penalty: signals.hub,
                conflict_penalty: signals.conflict,
                stale_superseded_penalty: signals.superseded,
                total: evidence::planned_recall_score(candidate, signals, policy),
            },
        }
    }

    /// The diagnostics about the corpus, the policy and the score gate.
    fn diagnostics(
        &self,
        corpus: &LegacyRecallCorpus,
        policy: &ActivePolicy,
        score_gate: &str,
    ) -> Vec<String> {
        let (ranking, ranking_policy) = if policy.planned {
            ("planned_policy", "planned")
        } else {
            ("fallback_evidence", "fallback")
        };
        vec![
            format!("candidates={}", corpus.candidates.len()),
            format!(
                "activated_nodes={}",
                self.activation
                    .values()
                    .filter(|value| **value > 0.0)
                    .count()
            ),
            format!("ranking={ranking}"),
            format!("ranking_policy={ranking_policy}"),
            score_gate.to_owned(),
            format!(
                "context_terms={}",
                self.contextual_evidence
                    .as_ref()
                    .map_or(0, |value| value.terms.len())
            ),
        ]
    }
}

fn normalized_limit(limit: Option<f64>) -> usize {
    let value = limit.unwrap_or(DEFAULT_LIMIT).trunc();
    if value.is_nan() {
        0
    } else {
        butler_core::json::saturating_usize(value.clamp(1.0, 10.0))
    }
}

fn semantic_score(candidate: &LegacyRecallCandidate) -> f64 {
    if candidate.source != LegacyRecallSource::Vector {
        return 0.0;
    }
    candidate.vector_similarity.map_or(0.0, clamp01)
}

fn recall_item(
    candidate: &LegacyRecallCandidate,
    breakdown: &LegacyRecallScoreBreakdown,
) -> LegacyRecallItem {
    LegacyRecallItem {
        summary: candidate.summary.clone(),
        confidence: clamp01(breakdown.total),
        source: source_for_candidate(
            candidate,
            breakdown.semantic_similarity,
            breakdown.graph_activation,
        ),
        original_source: candidate.original_source,
        provenance: candidate.provenance.clone(),
        related_nodes: candidate.related_nodes.clone(),
        score_breakdown: breakdown.clone(),
    }
}

fn source_for_candidate(
    candidate: &LegacyRecallCandidate,
    semantic: f64,
    graph: f64,
) -> LegacyRecallSource {
    if candidate.source == LegacyRecallSource::Explicit {
        return LegacyRecallSource::Explicit;
    }
    if graph > 0.0 && semantic > 0.0 {
        return LegacyRecallSource::Hybrid;
    }
    if graph > 0.0 {
        return LegacyRecallSource::Graph;
    }
    candidate.source
}

fn compare_scored(
    left: &ScoredCandidate<'_>,
    right: &ScoredCandidate<'_>,
    policy: &ActivePolicy,
) -> std::cmp::Ordering {
    if policy.planned {
        let left_index = evidence::planned_strategy_index(left.candidate, &left.breakdown, policy);
        let right_index =
            evidence::planned_strategy_index(right.candidate, &right.breakdown, policy);
        if left_index != right_index {
            return left_index.cmp(&right_index);
        }
    }
    if is_vector_semantic(left)
        && is_vector_semantic(right)
        && (left.breakdown.semantic_similarity - right.breakdown.semantic_similarity).abs()
            <= VECTOR_SEMANTIC_NEIGHBORHOOD_MARGIN
    {
        let delta = vector_corroboration(&right.breakdown) - vector_corroboration(&left.breakdown);
        if delta != 0.0 {
            return descending_subtract(
                vector_corroboration(&left.breakdown),
                vector_corroboration(&right.breakdown),
            );
        }
    }
    descending_subtract(left.breakdown.total, right.breakdown.total)
}

fn descending_subtract(left: f64, right: f64) -> std::cmp::Ordering {
    let difference = right - left;
    if difference > 0.0 {
        std::cmp::Ordering::Greater
    } else if difference < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Equal
    }
}

fn is_vector_semantic(item: &ScoredCandidate<'_>) -> bool {
    item.candidate.source == LegacyRecallSource::Vector && item.breakdown.semantic_similarity > 0.0
}

fn vector_corroboration(breakdown: &LegacyRecallScoreBreakdown) -> f64 {
    js_max(
        js_max(breakdown.lexical_match, breakdown.contextual_match),
        js_max(breakdown.graph_activation, breakdown.explicit_salience),
    )
}

fn clamp01(value: f64) -> f64 {
    js_max(0.0, js_min(1.0, value))
}

fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left == 0.0 && right == 0.0 {
        if left.is_sign_positive() || right.is_sign_positive() {
            0.0
        } else {
            -0.0
        }
    } else {
        left.max(right)
    }
}

fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else if left == 0.0 && right == 0.0 {
        if left.is_sign_negative() || right.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else {
        left.min(right)
    }
}
