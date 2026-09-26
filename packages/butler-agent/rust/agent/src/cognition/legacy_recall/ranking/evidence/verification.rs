use super::ActivePolicy;
use crate::cognition::legacy_recall::types::{
    LegacyRecallEvidencePolicy, LegacyRecallEvidenceRequirement, LegacyRecallItem,
    LegacyRecallOriginalSource, LegacyRecallSource,
};

pub(in crate::cognition::legacy_recall::ranking) struct Verification {
    pub(in crate::cognition::legacy_recall::ranking) items: Vec<LegacyRecallItem>,
    pub(in crate::cognition::legacy_recall::ranking) diagnostics: Vec<String>,
}

pub(in crate::cognition::legacy_recall::ranking) fn verify_evidence(
    items: Vec<LegacyRecallItem>,
    policy: Option<&LegacyRecallEvidencePolicy>,
) -> Verification {
    let active = ActivePolicy::from(policy);
    let mut diagnostics = Vec::new();
    if active
        .evidence_required
        .contains(&LegacyRecallEvidenceRequirement::ExactQuote)
    {
        return Verification {
            items: Vec::new(),
            diagnostics: vec!["evidence=exact_quote_requires_query_memory".to_owned()],
        };
    }
    if items.is_empty() {
        for requirement in active
            .evidence_required
            .iter()
            .filter(|requirement| **requirement != LegacyRecallEvidenceRequirement::ExactQuote)
        {
            diagnostics.push(format!(
                "evidence_missing={}",
                requirement_name(*requirement)
            ));
        }
        if diagnostics.is_empty() {
            diagnostics.push("evidence=none".to_owned());
        }
        return Verification {
            items: Vec::new(),
            diagnostics,
        };
    }
    let usable = items
        .into_iter()
        .filter(|item| {
            let enough =
                item.score_breakdown.evidence_confidence >= active.minimum_evidence_confidence;
            let contradicted = active.exclude_contradicted
                && (item.score_breakdown.conflict_penalty > 0.0
                    || item.score_breakdown.stale_superseded_penalty > 0.0);
            enough && !contradicted
        })
        .collect::<Vec<_>>();
    if usable.is_empty() {
        return Verification {
            items: Vec::new(),
            diagnostics: vec!["evidence=weak_or_contradicted".to_owned()],
        };
    }
    let missing = active
        .evidence_required
        .iter()
        .filter(|requirement| **requirement != LegacyRecallEvidenceRequirement::ExactQuote)
        .filter(|requirement| {
            !usable
                .iter()
                .any(|item| item_satisfies_requirement(item, **requirement))
        })
        .copied()
        .collect::<Vec<_>>();
    for requirement in &missing {
        diagnostics.push(format!(
            "evidence_missing={}",
            requirement_name(*requirement)
        ));
    }
    if !missing.is_empty() {
        return Verification {
            items: Vec::new(),
            diagnostics,
        };
    }
    let non_exact = active
        .evidence_required
        .iter()
        .filter(|requirement| **requirement != LegacyRecallEvidenceRequirement::ExactQuote)
        .copied()
        .collect::<Vec<_>>();
    let scoped = if non_exact.is_empty() {
        usable
    } else {
        usable
            .into_iter()
            .filter(|item| {
                non_exact
                    .iter()
                    .any(|requirement| item_satisfies_requirement(item, *requirement))
            })
            .collect::<Vec<_>>()
    };
    if active.require_specific_memory && scoped.len() > 1 {
        let margin = super::super::js_max(0.0, active.tie_margin);
        if scoped[0].confidence - scoped[1].confidence <= margin {
            return Verification {
                items: Vec::new(),
                diagnostics: vec!["evidence=ambiguous_tie".to_owned()],
            };
        }
    }
    diagnostics.push("evidence=verified".to_owned());
    Verification {
        items: scoped,
        diagnostics,
    }
}

fn item_satisfies_requirement(
    item: &LegacyRecallItem,
    requirement: LegacyRecallEvidenceRequirement,
) -> bool {
    let breakdown = &item.score_breakdown;
    match requirement {
        LegacyRecallEvidenceRequirement::ExactQuote => false,
        LegacyRecallEvidenceRequirement::VectorEpisodeHit => {
            breakdown.semantic_similarity > 0.0
                && item
                    .provenance
                    .iter()
                    .any(|entry| entry.starts_with("vector:"))
        }
        LegacyRecallEvidenceRequirement::ProjectMemoryHit => {
            (item.source == LegacyRecallSource::ProjectMemory
                || item.original_source == Some(LegacyRecallOriginalSource::ProjectMemory))
                && max_many([
                    breakdown.lexical_match,
                    breakdown.contextual_match,
                    breakdown.graph_activation,
                ]) > 0.0
        }
        LegacyRecallEvidenceRequirement::GraphRelationHit => {
            breakdown.graph_activation > 0.0 && !item.related_nodes.is_empty()
        }
        LegacyRecallEvidenceRequirement::ExplicitRuleHit => {
            (item.source == LegacyRecallSource::Explicit
                || item.original_source == Some(LegacyRecallOriginalSource::Rules))
                && breakdown.explicit_salience > 0.0
        }
        LegacyRecallEvidenceRequirement::RecentTurnHit => {
            (item.source == LegacyRecallSource::HotCache
                || item
                    .provenance
                    .iter()
                    .any(|entry| entry.starts_with("session:") || entry.starts_with("turn:")))
                && super::super::js_max(breakdown.contextual_match, breakdown.lexical_match) > 0.0
        }
        LegacyRecallEvidenceRequirement::TaskContinuity => {
            if breakdown.contextual_match > 0.0 {
                true
            } else {
                item.provenance
                    .iter()
                    .any(|entry| entry.starts_with("task:") || entry.contains(":task:"))
                    && max_many([
                        breakdown.lexical_match,
                        breakdown.graph_activation,
                        breakdown.explicit_salience,
                    ]) > 0.0
            }
        }
    }
}

fn max_many(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(0.0, super::super::js_max)
}

fn requirement_name(requirement: LegacyRecallEvidenceRequirement) -> &'static str {
    match requirement {
        LegacyRecallEvidenceRequirement::ExactQuote => "exact_quote",
        LegacyRecallEvidenceRequirement::RecentTurnHit => "recent_turn_hit",
        LegacyRecallEvidenceRequirement::TaskContinuity => "task_continuity",
        LegacyRecallEvidenceRequirement::ProjectMemoryHit => "project_memory_hit",
        LegacyRecallEvidenceRequirement::VectorEpisodeHit => "vector_episode_hit",
        LegacyRecallEvidenceRequirement::ExplicitRuleHit => "explicit_rule_hit",
        LegacyRecallEvidenceRequirement::GraphRelationHit => "graph_relation_hit",
    }
}
