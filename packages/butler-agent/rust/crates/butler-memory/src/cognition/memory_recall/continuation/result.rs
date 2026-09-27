//! Source-bound cursor result and its complete-bundle response projection.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::cognition::{
    CognitionResult, CognitionSourceRow,
    graph::{GraphRecallReader, RecallEpisodeRow, RecallMention, RelationshipState},
    recall::{
        RecallCoverage, RecallCoverageLane, RecallCoverageState, RecallEvidence, RecallRequest,
        RecallResponse, RecallResultItem, RecallStatus,
    },
    sources::RecallSourceResolution,
};

use super::super::{
    binding,
    cursor::{self, Candidate, Inventory},
    evidence,
};

/// One cursor candidate and the fresh reads it is rebound from.
pub(super) struct BindInput<'a> {
    pub graph: &'a GraphRecallReader,
    pub input: &'a RecallRequest,
    pub generation_id: &'a str,
    pub row: &'a RecallEpisodeRow,
    pub metadata: &'a Candidate,
    pub mentions: &'a [RecallMention],
    pub relationship: &'a RelationshipState,
    pub sources: &'a HashMap<&'a str, &'a CognitionSourceRow>,
    pub hydrated: &'a HashMap<String, RecallSourceResolution>,
    pub now_iso: &'a str,
}

/// The candidate's result from up to three hydrated sources, or `None` when
/// none is left or it has no summary.
pub(super) fn bind(
    request: &BindInput<'_>,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<Option<RecallResultItem>> {
    let BindInput {
        graph,
        input,
        row,
        metadata,
        ..
    } = *request;
    let delivered = delivered(request, parse_date);
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
            request.mentions,
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
    let mut historical = Vec::new();
    if graph.historical_claim(input, &row.episode_id, request.now_iso, parse_date)? {
        historical.push("historical".into());
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
        qualifications: qualifications(request, &surviving, historical),
    }))
}

/// Up to three distinct hydrated sources in handle order.
fn delivered(request: &BindInput<'_>, parse_date: &dyn Fn(&str) -> f64) -> Vec<RecallEvidence> {
    let mut ordered = request.mentions.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| {
        binding::compare_handles(
            request.sources.get(a.source_id.as_str()).copied(),
            request.sources.get(b.source_id.as_str()).copied(),
            &request.relationship.priority_source_ids,
            parse_date,
        )
    });
    let mut seen = HashSet::new();
    let mut delivered = Vec::new();
    for mention in ordered {
        if !seen.insert(mention.source_id.as_str()) {
            continue;
        }
        let Some(RecallSourceResolution::Value(source)) = request.hydrated.get(&mention.source_id)
        else {
            continue;
        };
        let source_ref = evidence::handle(request.generation_id, &source.source_ref);
        delivered.push(RecallEvidence {
            source_ref: source_ref.clone(),
            basis: source.basis.clone(),
            source_kind: binding::source_kind(&source.source_kind),
            excerpt: source.excerpt.clone(),
            source_resolved: true,
            conversation_session_id: source.conversation_session_id.clone(),
            conversation_message_id: source.conversation_message_id.clone(),
            support: binding::support(mention),
            read_args: binding::read_args(request.input, source_ref),
        });
        if delivered.len() >= 3 {
            break;
        }
    }
    delivered
}

/// Appends the relationship's qualifications, and `uncertain` for an
/// unknown-origin source.
fn qualifications(
    request: &BindInput<'_>,
    surviving: &HashSet<String>,
    mut qualifications: Vec<String>,
) -> Vec<String> {
    qualifications.extend(request.relationship.qualifications.iter().cloned());
    if surviving.iter().any(|id| {
        request
            .sources
            .get(id.as_str())
            .is_some_and(|source| source.origin_kind == "unknown")
    }) {
        qualifications.push("uncertain".into());
    }
    qualifications
}

pub(super) fn rebind(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    row: &RecallEpisodeRow,
    mentions: &[RecallMention],
    original: &RecallResultItem,
    evidence: Vec<RecallEvidence>,
    parse_date: &dyn Fn(&str) -> f64,
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

/// The cursor page being continued.
pub(super) struct PageFrame<'a> {
    pub inventory: &'a Inventory,
    pub key: &'a str,
    pub offset: usize,
    pub page_len: usize,
}

/// Which candidates of the page were delivered and why some were not.
pub(super) struct Delivery<'a> {
    /// Page offsets of the delivered results.
    pub included: &'a [usize],
    /// A candidate or source could not be rebound.
    pub source_partial: bool,
    /// The envelope budget cut the page short.
    pub budget_trimmed: bool,
}

/// The response for `results`; a budget-trimmed page continues after its
/// last delivered candidate.
pub(super) fn view<'a>(
    frame: &PageFrame<'_>,
    results: &'a [RecallResultItem],
    delivery: &Delivery<'_>,
) -> View<'a> {
    let inventory = frame.inventory;
    let next_offset = match delivery.included.last() {
        Some(last) if delivery.budget_trimmed => frame.offset + last + 1,
        _ => frame.offset + frame.page_len,
    };
    let next_cursor =
        (next_offset < inventory.candidates.len()).then(|| cursor::encode(frame.key, next_offset));
    let partial = matches!(inventory.status, Some(RecallStatus::Partial))
        || delivery.source_partial
        || delivery.budget_trimmed
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
        coverage: coverage(inventory, results.len(), delivery),
        next_cursor,
        diagnostics: inventory.diagnostics.clone().unwrap_or_default(),
    }
}

/// The first page's coverage, with the source lane marked partial for what
/// this page could not deliver.
fn coverage(inventory: &Inventory, delivered: usize, delivery: &Delivery<'_>) -> RecallCoverage {
    let prior = inventory.coverage.as_ref();
    let mut source_codes = prior.map_or_else(Vec::new, |coverage| coverage.source.codes.clone());
    for (condition, code) in [
        (delivery.source_partial, "source_resolution_failed"),
        (delivery.budget_trimmed, "serialization_budget"),
    ] {
        if condition && !source_codes.iter().any(|value| value == code) {
            source_codes.push(code.into());
        }
    }
    RecallCoverage {
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
            candidates: delivered,
            codes: source_codes,
        },
    }
}
