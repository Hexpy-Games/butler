mod verification;

use super::super::types::{
    LegacyRecallCandidate, LegacyRecallEvidencePolicy, LegacyRecallEvidenceRequirement,
    LegacyRecallOriginalSource, LegacyRecallScoreBreakdown, LegacyRecallSource,
    LegacyRecallStrategy,
};
use super::RankingSignals;

pub(super) const SUPERSEDED_MEMORY_PENALTY: f64 = 0.7;
pub(super) use verification::verify_evidence;
pub(super) struct ActivePolicy {
    pub planned: bool,
    pub(super) strategies: Vec<LegacyRecallStrategy>,
    pub(super) evidence_required: Vec<LegacyRecallEvidenceRequirement>,
    minimum_evidence_confidence: f64,
    require_specific_memory: bool,
    tie_margin: f64,
    exclude_contradicted: bool,
}

impl From<Option<&LegacyRecallEvidencePolicy>> for ActivePolicy {
    fn from(value: Option<&LegacyRecallEvidencePolicy>) -> Self {
        let Some(value) = value else {
            return Self {
                planned: false,
                strategies: Vec::new(),
                evidence_required: Vec::new(),
                minimum_evidence_confidence: 0.0,
                require_specific_memory: false,
                tie_margin: 0.0,
                exclude_contradicted: false,
            };
        };
        let mut strategies = Vec::new();
        let mut evidence_required = Vec::new();
        if let Some(plan) = &value.retrieval_plan {
            extend_unique(&mut strategies, &plan.strategies);
            extend_unique(&mut evidence_required, &plan.evidence_required);
        }
        extend_unique(&mut strategies, &value.strategies);
        extend_unique(&mut evidence_required, &value.evidence_required);
        Self {
            planned: !strategies.is_empty() || !evidence_required.is_empty(),
            strategies,
            evidence_required,
            minimum_evidence_confidence: value.min_evidence_confidence.unwrap_or(0.0),
            require_specific_memory: value.require_specific_memory == Some(true),
            tie_margin: value.tie_margin.unwrap_or(0.0),
            exclude_contradicted: value.exclude_contradicted == Some(true),
        }
    }
}

impl ActivePolicy {
    pub(super) fn non_exact_evidence_count(&self) -> usize {
        self.evidence_required
            .iter()
            .filter(|requirement| **requirement != LegacyRecallEvidenceRequirement::ExactQuote)
            .count()
    }
}

pub(super) fn evidence_confidence(
    candidate: &LegacyRecallCandidate,
    signals: RankingSignals,
    policy: &ActivePolicy,
) -> f64 {
    if !policy.planned {
        return fallback_evidence_score(signals);
    }
    let planned_scores = policy
        .strategies
        .iter()
        .map(|strategy| planned_strategy_evidence_score(*strategy, candidate, signals, policy));
    let requirement_scores = policy
        .evidence_required
        .iter()
        .filter(|requirement| **requirement != LegacyRecallEvidenceRequirement::ExactQuote)
        .map(|requirement| evidence_requirement_score(*requirement, candidate, signals));
    planned_scores
        .chain(requirement_scores)
        .fold(0.0, super::js_max)
}

pub(super) fn planned_recall_score(
    candidate: &LegacyRecallCandidate,
    signals: RankingSignals,
    policy: &ActivePolicy,
) -> f64 {
    if !policy.planned {
        return fallback_recall_score(signals);
    }
    let strategy_scores = policy
        .strategies
        .iter()
        .map(|strategy| planned_strategy_evidence_score(*strategy, candidate, signals, policy));
    let requirement_scores = policy
        .evidence_required
        .iter()
        .map(|requirement| evidence_requirement_score(*requirement, candidate, signals))
        .collect::<Vec<_>>();
    if !requirement_scores.is_empty() && requirement_scores.iter().all(|score| *score <= 0.0) {
        return 0.0;
    }
    let best_evidence = strategy_scores
        .chain(requirement_scores)
        .fold(0.0, super::js_max);
    if best_evidence <= 0.0 {
        return 0.0;
    }
    super::clamp01(best_evidence + signals.boost - recall_penalty(signals))
}

pub(super) fn planned_strategy_index(
    candidate: &LegacyRecallCandidate,
    breakdown: &LegacyRecallScoreBreakdown,
    policy: &ActivePolicy,
) -> usize {
    if !policy.planned {
        return usize::MAX;
    }
    let signals = RankingSignals {
        semantic: breakdown.semantic_similarity,
        lexical: breakdown.lexical_match,
        contextual: breakdown.contextual_match,
        graph: breakdown.graph_activation,
        recency: breakdown.recency_score,
        frequency: breakdown.frequency_score,
        explicit: breakdown.explicit_salience,
        boost: breakdown.decision_preference_boost,
        hub: breakdown.hub_penalty,
        conflict: breakdown.conflict_penalty,
        superseded: breakdown.stale_superseded_penalty,
    };
    policy
        .strategies
        .iter()
        .position(|strategy| {
            planned_strategy_evidence_score(*strategy, candidate, signals, policy) > 0.0
        })
        .unwrap_or(usize::MAX)
}

fn extend_unique<T: Copy + Eq>(target: &mut Vec<T>, values: &[T]) {
    for value in values {
        if !target.contains(value) {
            target.push(*value);
        }
    }
}

fn evidence_requirement_score(
    requirement: LegacyRecallEvidenceRequirement,
    candidate: &LegacyRecallCandidate,
    signals: RankingSignals,
) -> f64 {
    match requirement {
        LegacyRecallEvidenceRequirement::ExactQuote => 0.0,
        LegacyRecallEvidenceRequirement::VectorEpisodeHit => {
            if has_vector_provenance(candidate) {
                signals.semantic
            } else {
                0.0
            }
        }
        LegacyRecallEvidenceRequirement::ProjectMemoryHit => {
            if has_project_memory_provenance(candidate) {
                max_many([
                    signals.lexical,
                    signals.contextual,
                    signals.graph,
                    signals.explicit,
                ])
            } else {
                0.0
            }
        }
        LegacyRecallEvidenceRequirement::GraphRelationHit => {
            if !candidate.related_nodes.is_empty() {
                signals.graph
            } else {
                0.0
            }
        }
        LegacyRecallEvidenceRequirement::ExplicitRuleHit => {
            if candidate.source == LegacyRecallSource::Explicit
                || candidate.original_source == Some(LegacyRecallOriginalSource::Rules)
            {
                signals.explicit
            } else {
                0.0
            }
        }
        LegacyRecallEvidenceRequirement::TaskContinuity => {
            if signals.contextual > 0.0 {
                signals.contextual
            } else if has_task_continuity_provenance(candidate) {
                max_many([signals.lexical, signals.graph, signals.explicit])
            } else {
                0.0
            }
        }
        LegacyRecallEvidenceRequirement::RecentTurnHit => {
            if has_recent_turn_provenance(candidate) {
                super::js_max(signals.contextual, signals.lexical)
            } else {
                0.0
            }
        }
    }
}

fn strategy_evidence_score(
    strategy: LegacyRecallStrategy,
    candidate: &LegacyRecallCandidate,
    signals: RankingSignals,
) -> f64 {
    match strategy {
        LegacyRecallStrategy::SearchVectorEpisode => evidence_requirement_score(
            LegacyRecallEvidenceRequirement::VectorEpisodeHit,
            candidate,
            signals,
        ),
        LegacyRecallStrategy::SearchLexicalMemory => signals.lexical,
        LegacyRecallStrategy::ReadGraphMemory => evidence_requirement_score(
            LegacyRecallEvidenceRequirement::GraphRelationHit,
            candidate,
            signals,
        ),
        LegacyRecallStrategy::ReadExplicitMemory => evidence_requirement_score(
            LegacyRecallEvidenceRequirement::ExplicitRuleHit,
            candidate,
            signals,
        ),
        LegacyRecallStrategy::ReadTaskState => evidence_requirement_score(
            LegacyRecallEvidenceRequirement::TaskContinuity,
            candidate,
            signals,
        ),
        LegacyRecallStrategy::ReadRecentContext => super::js_max(
            signals.contextual,
            evidence_requirement_score(
                LegacyRecallEvidenceRequirement::RecentTurnHit,
                candidate,
                signals,
            ),
        ),
        LegacyRecallStrategy::QueryExactTranscript => 0.0,
    }
}

fn planned_strategy_evidence_score(
    strategy: LegacyRecallStrategy,
    candidate: &LegacyRecallCandidate,
    signals: RankingSignals,
    policy: &ActivePolicy,
) -> f64 {
    if let Some(mapped) = requirement_for_strategy(strategy)
        && policy.evidence_required.contains(&mapped)
        && evidence_requirement_score(mapped, candidate, signals) <= 0.0
    {
        return 0.0;
    }
    strategy_evidence_score(strategy, candidate, signals)
}

fn requirement_for_strategy(
    strategy: LegacyRecallStrategy,
) -> Option<LegacyRecallEvidenceRequirement> {
    match strategy {
        LegacyRecallStrategy::SearchVectorEpisode => {
            Some(LegacyRecallEvidenceRequirement::VectorEpisodeHit)
        }
        LegacyRecallStrategy::SearchLexicalMemory => {
            Some(LegacyRecallEvidenceRequirement::ProjectMemoryHit)
        }
        LegacyRecallStrategy::ReadGraphMemory => {
            Some(LegacyRecallEvidenceRequirement::GraphRelationHit)
        }
        LegacyRecallStrategy::ReadExplicitMemory => {
            Some(LegacyRecallEvidenceRequirement::ExplicitRuleHit)
        }
        LegacyRecallStrategy::ReadTaskState => {
            Some(LegacyRecallEvidenceRequirement::TaskContinuity)
        }
        LegacyRecallStrategy::ReadRecentContext => {
            Some(LegacyRecallEvidenceRequirement::RecentTurnHit)
        }
        LegacyRecallStrategy::QueryExactTranscript => {
            Some(LegacyRecallEvidenceRequirement::ExactQuote)
        }
    }
}

fn has_vector_provenance(candidate: &LegacyRecallCandidate) -> bool {
    candidate.source == LegacyRecallSource::Vector
        && candidate
            .provenance
            .iter()
            .any(|entry| entry.starts_with("vector:"))
}

fn has_project_memory_provenance(candidate: &LegacyRecallCandidate) -> bool {
    candidate.source == LegacyRecallSource::ProjectMemory
        || candidate.original_source == Some(LegacyRecallOriginalSource::ProjectMemory)
}

fn has_task_continuity_provenance(candidate: &LegacyRecallCandidate) -> bool {
    candidate
        .provenance
        .iter()
        .any(|entry| entry.starts_with("task:") || entry.contains(":task:"))
}

fn has_recent_turn_provenance(candidate: &LegacyRecallCandidate) -> bool {
    candidate.source == LegacyRecallSource::HotCache
        || candidate
            .provenance
            .iter()
            .any(|entry| entry.starts_with("session:") || entry.starts_with("turn:"))
}

fn fallback_evidence_score(signals: RankingSignals) -> f64 {
    max_many([
        signals.semantic,
        signals.lexical,
        signals.contextual,
        signals.explicit,
    ])
}

fn fallback_recall_score(signals: RankingSignals) -> f64 {
    if signals.superseded > 0.0 {
        return 0.0;
    }
    let evidence = fallback_evidence_score(signals);
    if evidence <= 0.0 {
        return 0.0;
    }
    super::clamp01(evidence + signals.boost - recall_penalty(signals))
}

fn recall_penalty(signals: RankingSignals) -> f64 {
    max_many([signals.hub, signals.conflict, signals.superseded])
}

fn max_many(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(0.0, super::js_max)
}
