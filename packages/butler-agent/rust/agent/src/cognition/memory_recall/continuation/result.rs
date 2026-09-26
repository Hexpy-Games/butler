//! Source-bound cursor result and its complete-bundle response projection.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::cognition::{
    CognitionResult, CognitionSourceRow,
    graph::{GraphRecallReader, RecallEpisodeRow, RecallMention, RelationshipState},
    recall::{
        RecallCoverage, RecallCoverageLane, RecallCoverageState, RecallEvidence,
        RecallEvidenceRelation, RecallEvidenceSupport, RecallRequest, RecallResponse,
        RecallResultItem, RecallStatus,
    },
    sources::RecallSourceResolution,
};

use super::super::{
    binding,
    cursor::{self, Candidate, Inventory},
    evidence,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn bind(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    generation_id: &str,
    row: &RecallEpisodeRow,
    metadata: &Candidate,
    mentions: &[RecallMention],
    relationship: &RelationshipState,
    sources: &HashMap<&str, &CognitionSourceRow>,
    hydrated: &HashMap<String, RecallSourceResolution>,
    now_iso: &str,
    parse_date: &impl Fn(&str) -> f64,
) -> CognitionResult<Option<RecallResultItem>> {
    let mut ordered = mentions.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| {
        binding::compare_handles(
            sources.get(a.source_id.as_str()).copied(),
            sources.get(b.source_id.as_str()).copied(),
            &relationship.priority_source_ids,
            parse_date,
        )
    });
    let mut seen = HashSet::new();
    let mut delivered = Vec::new();
    for mention in ordered {
        if !seen.insert(mention.source_id.as_str()) {
            continue;
        }
        let Some(RecallSourceResolution::Value(source)) = hydrated.get(&mention.source_id) else {
            continue;
        };
        let source_ref = evidence::handle(generation_id, &source.source_ref);
        delivered.push(RecallEvidence {
            source_ref: source_ref.clone(),
            basis: source.basis.clone(),
            source_kind: binding::source_kind(&source.source_kind),
            excerpt: source.excerpt.clone(),
            source_resolved: true,
            conversation_session_id: source.conversation_session_id.clone(),
            conversation_message_id: source.conversation_message_id.clone(),
            support: RecallEvidenceSupport {
                node_ref: mention.node_id.clone(),
                relation: if mention.supports {
                    RecallEvidenceRelation::Supports
                } else {
                    RecallEvidenceRelation::Mentions
                },
            },
            read_args: binding::read_args(input, source_ref),
        });
        if delivered.len() >= 3 {
            break;
        }
    }
    if delivered.is_empty() {
        return Ok(None);
    }
    let surviving = delivered
        .iter()
        .filter_map(|item| evidence::raw_source_id(&item.source_ref))
        .collect::<HashSet<_>>();
    let interpreted = if row.has_claims {
        graph.matched_claim_summary(
            input,
            &row.episode_id,
            metadata.matched_node_ref.as_deref(),
            mentions,
            &surviving,
        )?
    } else {
        None
    };
    let Some(summary) = interpreted
        .or_else(|| delivered.first().map(|item| item.excerpt.clone()))
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let refs = delivered
        .iter()
        .filter_map(|item| {
            evidence::raw_source_id(&item.source_ref).map(|id| (id, item.source_ref.clone()))
        })
        .collect::<Vec<_>>();
    let interpretations = graph.result_interpretations(input, &refs, parse_date)?;
    let requirements = graph.result_requirements(input, &refs)?;
    let historical = graph.historical_claim(input, &row.episode_id, now_iso, parse_date)?;
    let mut qualifications = Vec::new();
    if historical {
        qualifications.push("historical".into());
    }
    qualifications.extend(relationship.qualifications.iter().cloned());
    if surviving.iter().any(|id| {
        sources
            .get(id.as_str())
            .is_some_and(|source| source.origin_kind == "unknown")
    }) {
        qualifications.push("uncertain".into());
    }
    Ok(Some(RecallResultItem {
        episode_ref: row.episode_id.clone(),
        revision: row.revision.clone(),
        summary,
        occurred_at: row.event_at.clone(),
        conversation_at: row.conversation_at.clone(),
        channels: metadata.channels.clone(),
        matched_node_ref: metadata.matched_node_ref.clone(),
        association_path: metadata.association_path.clone(),
        evidence: delivered,
        requirements,
        interpretations,
        current_state_requires_verification: true,
        qualifications,
    }))
}

pub(super) fn rebind(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    row: &RecallEpisodeRow,
    mentions: &[RecallMention],
    original: &RecallResultItem,
    evidence: Vec<RecallEvidence>,
    parse_date: &impl Fn(&str) -> f64,
) -> CognitionResult<Option<RecallResultItem>> {
    let surviving = evidence
        .iter()
        .filter_map(|item| super::super::evidence::raw_source_id(&item.source_ref))
        .collect::<HashSet<_>>();
    let interpreted = if row.has_claims {
        graph.matched_claim_summary(
            input,
            &row.episode_id,
            original.matched_node_ref.as_deref(),
            mentions,
            &surviving,
        )?
    } else {
        None
    };
    let Some(summary) = interpreted.or_else(|| evidence.first().map(|item| item.excerpt.clone()))
    else {
        return Ok(None);
    };
    let refs = evidence
        .iter()
        .filter_map(|item| {
            super::super::evidence::raw_source_id(&item.source_ref)
                .map(|id| (id, item.source_ref.clone()))
        })
        .collect::<Vec<_>>();
    let mut item = original.clone();
    item.summary = summary;
    item.evidence = evidence;
    item.requirements = graph.result_requirements(input, &refs)?;
    item.interpretations = graph.result_interpretations(input, &refs, parse_date)?;
    Ok(Some(item))
}

#[derive(Serialize)]
pub(super) struct View<'a> {
    status: RecallStatus,
    results: &'a [RecallResultItem],
    coverage: RecallCoverage,
    next_cursor: Option<String>,
    diagnostics: Vec<String>,
}

impl View<'_> {
    pub(super) fn into_owned(self) -> RecallResponse {
        RecallResponse {
            status: self.status,
            results: self.results.to_vec(),
            coverage: self.coverage,
            next_cursor: self.next_cursor,
            diagnostics: self.diagnostics,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn view<'a>(
    inventory: &Inventory,
    results: &'a [RecallResultItem],
    key: &str,
    offset: usize,
    page_len: usize,
    included: &[usize],
    source_partial: bool,
    budget_trimmed: bool,
) -> View<'a> {
    let next_offset = if budget_trimmed && !included.is_empty() {
        offset + included[included.len() - 1] + 1
    } else {
        offset + page_len
    };
    let next_cursor =
        (next_offset < inventory.candidates.len()).then(|| cursor::encode(key, next_offset));
    let prior = inventory.coverage.as_ref();
    let mut source_codes = prior.map_or_else(Vec::new, |coverage| coverage.source.codes.clone());
    for (condition, code) in [
        (source_partial, "source_resolution_failed"),
        (budget_trimmed, "serialization_budget"),
    ] {
        if condition && !source_codes.iter().any(|value| value == code) {
            source_codes.push(code.into());
        }
    }
    let partial = matches!(inventory.status, Some(RecallStatus::Partial))
        || source_partial
        || budget_trimmed
        || next_cursor.is_some();
    View {
        status: if matches!(inventory.status, Some(RecallStatus::Unavailable)) && results.is_empty()
        {
            RecallStatus::Unavailable
        } else if partial {
            RecallStatus::Partial
        } else {
            RecallStatus::Complete
        },
        results,
        coverage: RecallCoverage {
            graph: prior.map_or_else(
                || RecallCoverageLane {
                    state: RecallCoverageState::Ok,
                    candidates: inventory.candidates.len(),
                    codes: vec![],
                },
                |value| value.graph.clone(),
            ),
            vectors: prior.map_or_else(
                || RecallCoverageLane {
                    state: RecallCoverageState::DisabledByRequest,
                    candidates: 0,
                    codes: vec![],
                },
                |value| value.vectors.clone(),
            ),
            source: RecallCoverageLane {
                state: if source_codes.is_empty() {
                    prior.map_or(RecallCoverageState::Ok, |value| value.source.state)
                } else {
                    RecallCoverageState::Partial
                },
                candidates: results.len(),
                codes: source_codes,
            },
        },
        next_cursor,
        diagnostics: inventory.diagnostics.clone().unwrap_or_default(),
    }
}
