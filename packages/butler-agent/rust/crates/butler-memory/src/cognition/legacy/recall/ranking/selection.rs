use super::{LegacyRecallScoreBreakdown, LegacyRecallSource, evidence::ActivePolicy};

pub(super) const LOW_CONFIDENCE_RECALL_FLOOR: f64 = 0.0001;
const LOW_CONFIDENCE_DOMINANCE_RATIO: f64 = 2.0;
const LOW_CONFIDENCE_MIN_LEXICAL_SEED_MATCHES: usize = 2;
const VECTOR_AMBIGUITY_SCAN_MARGIN: f64 = 0.05;
const VECTOR_AMBIGUOUS_NEIGHBORHOOD_MIN_CORROBORATION: f64 = 0.025;

#[derive(Clone, Debug)]
pub(super) struct ScoredCandidate<'a> {
    pub candidate: &'a super::super::types::LegacyRecallCandidate,
    pub lexical_matched_seed_count: usize,
    pub breakdown: LegacyRecallScoreBreakdown,
}

pub(super) struct ScoreGateSelection {
    pub items: Vec<usize>,
    pub diagnostic: &'static str,
}

pub(super) fn select_scored_candidates(
    scored: &[ScoredCandidate<'_>],
    min_score: f64,
    limit: usize,
    policy: &ActivePolicy,
) -> ScoreGateSelection {
    let standard = scored
        .iter()
        .enumerate()
        .filter_map(|(index, item)| (item.breakdown.total >= min_score).then_some(index))
        .collect::<Vec<_>>();
    if !standard.is_empty() {
        if has_ambiguous_vector_neighborhood(scored, &standard)
            && vector_corroboration(&scored[standard[0]].breakdown)
                < VECTOR_AMBIGUOUS_NEIGHBORHOOD_MIN_CORROBORATION
        {
            let corroborated = standard
                .iter()
                .copied()
                .filter(|index| {
                    !is_vector_semantic(&scored[*index])
                        || vector_corroboration(&scored[*index].breakdown)
                            >= VECTOR_AMBIGUOUS_NEIGHBORHOOD_MIN_CORROBORATION
                })
                .collect::<Vec<_>>();
            if !corroborated.is_empty() {
                return ScoreGateSelection {
                    items: corroborated.into_iter().take(limit).collect(),
                    diagnostic: "score_gate=corroborated-vector-neighborhood",
                };
            }
            return ScoreGateSelection {
                items: Vec::new(),
                diagnostic: "score_gate=ambiguous-vector-neighborhood",
            };
        }
        return ScoreGateSelection {
            items: standard.into_iter().take(limit).collect(),
            diagnostic: "score_gate=standard",
        };
    }

    let low_confidence = scored
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            (item.breakdown.total >= LOW_CONFIDENCE_RECALL_FLOOR
                && item.breakdown.total < min_score)
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if low_confidence.is_empty() {
        return ScoreGateSelection {
            items: Vec::new(),
            diagnostic: "score_gate=below-floor",
        };
    }
    if !low_confidence_candidate_dominates(scored, &low_confidence, policy) {
        return ScoreGateSelection {
            items: Vec::new(),
            diagnostic: "score_gate=ambiguous-low-confidence",
        };
    }
    ScoreGateSelection {
        items: low_confidence.into_iter().take(limit).collect(),
        diagnostic: "score_gate=dominant-low-confidence",
    }
}

fn has_ambiguous_vector_neighborhood(scored: &[ScoredCandidate<'_>], selected: &[usize]) -> bool {
    let Some(first) = selected.first().and_then(|index| scored.get(*index)) else {
        return false;
    };
    if !is_vector_semantic(first) {
        return false;
    }
    let Some(second) = selected
        .iter()
        .skip(1)
        .map(|index| &scored[*index])
        .find(|item| is_vector_semantic(item))
    else {
        return false;
    };
    first.breakdown.semantic_similarity - second.breakdown.semantic_similarity
        <= VECTOR_AMBIGUITY_SCAN_MARGIN
}

fn low_confidence_candidate_dominates(
    scored: &[ScoredCandidate<'_>],
    selected: &[usize],
    policy: &ActivePolicy,
) -> bool {
    let Some(first) = selected.first().and_then(|index| scored.get(*index)) else {
        return false;
    };
    let first_score = first.breakdown.total;
    if first_score < LOW_CONFIDENCE_RECALL_FLOOR {
        return false;
    }
    if policy.planned {
        return true;
    }
    let lexical_only = first.breakdown.lexical_match > 0.0
        && first.breakdown.semantic_similarity <= 0.0
        && first.breakdown.contextual_match <= 0.0
        && first.breakdown.explicit_salience <= 0.0;
    if lexical_only && first.lexical_matched_seed_count < LOW_CONFIDENCE_MIN_LEXICAL_SEED_MATCHES {
        return false;
    }
    let second_score = selected
        .get(1)
        .and_then(|index| scored.get(*index))
        .map_or(0.0, |item| item.breakdown.total);
    second_score <= 0.0 || first_score / second_score >= LOW_CONFIDENCE_DOMINANCE_RATIO
}

fn is_vector_semantic(item: &ScoredCandidate<'_>) -> bool {
    item.candidate.source == LegacyRecallSource::Vector && item.breakdown.semantic_similarity > 0.0
}

fn vector_corroboration(breakdown: &LegacyRecallScoreBreakdown) -> f64 {
    super::js_max(
        super::js_max(breakdown.lexical_match, breakdown.contextual_match),
        super::js_max(breakdown.graph_activation, breakdown.explicit_salience),
    )
}
