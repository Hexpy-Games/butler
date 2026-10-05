//! Coverage, complete-bundle envelope and first-page cursor publication.
//!
//! [`initial`] registers the bound candidates as a cursor inventory, fits
//! minimum bundles into the envelope (up to the limit), upgrades them to
//! full bundles where they fit, and records the page's status and coverage
//! on the cursor. [`empty`] answers a search with no seeds at all.

use serde::Serialize;

use crate::cognition::{
    CognitionResult,
    graph::GraphRecallReader,
    recall::{
        RecallCoverage, RecallCoverageLane, RecallCoverageState, RecallRequest, RecallResponse,
        RecallResultItem, RecallStatus,
    },
};

use super::{
    Clocks,
    binding::{self, Binding},
    cursor::{self, CursorStore},
    envelope,
    selection::Selection,
};
mod empty;
use empty::disabled;
pub(super) use empty::empty;

/// What the vector lane contributed to a first page.
#[derive(Clone, Default)]
pub(super) struct VectorFacts {
    pub code: Option<String>,
    pub diagnostics: Vec<String>,
    pub candidates: usize,
    pub partial: bool,
    pub searched: bool,
    pub matches: Option<crate::cognition::recall::RecallVectorMatches>,
}

#[derive(Serialize)]
struct ResponseView<'a> {
    status: RecallStatus,
    results: &'a [RecallResultItem],
    coverage: RecallCoverage,
    next_cursor: Option<String>,
    diagnostics: Vec<String>,
}

impl ResponseView<'_> {
    fn into_owned(self) -> RecallResponse {
        RecallResponse {
            detail_pin: None,
            full_details: Vec::new(),
            status: self.status,
            results: self.results.to_vec(),
            coverage: self.coverage,
            next_cursor: self.next_cursor,
            diagnostics: self.diagnostics,
        }
    }
}

/// How complete a recall's execution was.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Complete,
    /// Some lane or source was cut short.
    Partial,
    /// Execution itself failed; with no results the recall is unavailable.
    Failed,
}

/// The reads a first page is published from.
#[derive(Clone, Copy)]
pub(super) struct FirstPage<'a> {
    pub graph: &'a GraphRecallReader,
    pub input: &'a RecallRequest,
    pub generation_id: &'a str,
    pub selection: &'a Selection,
    pub binding: &'a Binding,
    pub vector: &'a VectorFacts,
    pub deadline_at: i64,
    pub now_iso: &'a str,
}

/// Where the page stands against the envelope and the deadline.
#[derive(Clone, Copy)]
struct PageLimits {
    next_offset: usize,
    candidate_count: usize,
    /// A result was dropped to fit the envelope.
    budget_hit: bool,
    /// The operation deadline passed.
    deadline_hit: bool,
}

pub(super) fn initial(
    request: &FirstPage<'_>,
    cursors: &CursorStore,
    clocks: Clocks<'_>,
) -> CognitionResult<RecallResponse> {
    let FirstPage {
        input,
        selection,
        binding,
        vector,
        ..
    } = *request;
    if selection.empty_search {
        return Ok(empty(
            input,
            selection,
            vector,
            (clocks.now_millis)() >= request.deadline_at,
        ));
    }
    let metadata = binding
        .candidates
        .iter()
        .map(|candidate| {
            let item = &candidate.item;
            cursor::Candidate {
                episode_ref: item.episode_ref.clone(),
                revision: item.revision.clone(),
                channels: item.channels.clone(),
                matched_node_ref: item.matched_node_ref.clone(),
                association_path: item.association_path.clone(),
                qualifications: item.qualifications.clone(),
            }
        })
        .collect();
    let page = cursors.insert(
        input,
        request.generation_id,
        request.graph.revision(),
        metadata,
        (clocks.now_millis)(),
    )?;
    let candidate_count = page.inventory.candidates.len();
    let (results, offsets, mut limits) = fit_minimum(request, &page.key, candidate_count, clocks)?;
    let results = upgrade_to_full(request, &page.key, results, &offsets, &mut limits, clocks)?;
    limits.deadline_hit = (clocks.now_millis)() >= request.deadline_at;
    let mut response = build(request, &results, &page.key, limits).into_owned();
    super::details::retain_full(
        &mut response,
        binding.candidates.iter().map(|item| &item.item),
    )?;
    cursors.update(&page.key, &response);
    Ok(response)
}

/// Minimum bundles in rank order until the envelope is full or the limit is
/// reached, with their candidate offsets.
fn fit_minimum(
    request: &FirstPage<'_>,
    key: &str,
    candidate_count: usize,
    clocks: Clocks<'_>,
) -> CognitionResult<(Vec<RecallResultItem>, Vec<usize>, PageLimits)> {
    let binding = request.binding;
    let mut results = Vec::<RecallResultItem>::new();
    let mut offsets = Vec::<usize>::new();
    let mut limits = PageLimits {
        next_offset: 0,
        candidate_count,
        budget_hit: false,
        deadline_hit: false,
    };
    for (index, candidate) in binding.candidates.iter().enumerate() {
        let minimum = envelope::minimum(
            &candidate.item,
            |evidence| {
                binding::rebind(binding::RecallRebindInput {
                    graph: request.graph,
                    input: request.input,
                    selection: request.selection,
                    binding,
                    original: &candidate.item,
                    evidence,
                    now_iso: request.now_iso,
                    parse_date: clocks.parse_date,
                })
            },
            clocks.compare_locale,
        )?;
        results.push(minimum);
        offsets.push(index);
        limits.next_offset = index + 1;
        limits.deadline_hit = (clocks.now_millis)() >= request.deadline_at;
        if envelope::bytes(&build(request, &results, key, limits), &results)? > envelope::MAX_BYTES
        {
            results.pop();
            offsets.pop();
            limits.budget_hit = true;
            if !results.is_empty() {
                limits.next_offset = index;
                break;
            }
            continue;
        }
        if results.len() >= request.input.limit {
            break;
        }
    }
    Ok((results, offsets, limits))
}

/// Replaces each minimum bundle with its full bundle where the envelope
/// still fits.
fn upgrade_to_full(
    request: &FirstPage<'_>,
    key: &str,
    mut results: Vec<RecallResultItem>,
    offsets: &[usize],
    limits: &mut PageLimits,
    clocks: Clocks<'_>,
) -> CognitionResult<Vec<RecallResultItem>> {
    for (index, offset) in offsets.iter().enumerate() {
        let Some(full) = request.binding.candidates.get(*offset) else {
            continue;
        };
        let Some(slot) = results.get_mut(index) else {
            continue;
        };
        let minimum = std::mem::replace(slot, full.item.clone());
        limits.deadline_hit = (clocks.now_millis)() >= request.deadline_at;
        if envelope::bytes(&build(request, &results, key, *limits), &results)? > envelope::MAX_BYTES
            && let Some(slot) = results.get_mut(index)
        {
            *slot = minimum;
        }
    }
    Ok(results)
}

fn build<'a>(
    request: &FirstPage<'_>,
    results: &'a [RecallResultItem],
    key: &str,
    limits: PageLimits,
) -> ResponseView<'a> {
    let FirstPage {
        input,
        selection,
        binding,
        vector,
        ..
    } = *request;
    let next_cursor = (limits.next_offset < limits.candidate_count)
        .then(|| cursor::encode(key, limits.next_offset));
    let vector_partial =
        vector.partial || selection.vector_current.as_ref().is_some_and(|v| v.partial);
    let partial = selection.coverage.pending
        || !selection.coverage.codes.is_empty()
        || !binding.failed_sources.is_empty()
        || binding.source_deadline_hit
        || limits.budget_hit
        || !selection.selection_codes.is_empty()
        || !selection.expansion.coverage_codes.is_empty()
        || vector_partial
        || selection.candidate_limit
        || limits.deadline_hit
        || vector.code.is_some();
    ResponseView {
        status: derive_status(
            results.len(),
            if partial {
                Outcome::Failed
            } else {
                Outcome::Complete
            },
        ),
        results,
        coverage: RecallCoverage {
            graph: graph_lane(input, selection, limits.deadline_hit),
            vectors: vector_lane(input, selection, vector, vector_partial),
            source: source_lane(selection, binding, limits.budget_hit),
        },
        next_cursor,
        diagnostics: vector.diagnostics.clone(),
    }
}

/// Graph coverage: partial while projection is pending or with any selection
/// or expansion code.
fn graph_lane(
    input: &RecallRequest,
    selection: &Selection,
    deadline_hit: bool,
) -> RecallCoverageLane {
    if !input.admitted_channels.clone().unwrap_or_default().graph {
        return disabled();
    }
    let codes = selection
        .coverage
        .codes
        .iter()
        .cloned()
        .chain(selection.selection_codes.iter().cloned())
        .chain(selection.expansion.coverage_codes.iter().cloned())
        .chain(
            selection
                .candidate_limit
                .then_some("candidate_limit".into()),
        )
        .chain(deadline_hit.then_some("operation_deadline".into()))
        .collect::<Vec<_>>();
    RecallCoverageLane {
        state: if selection.coverage.pending || !codes.is_empty() {
            RecallCoverageState::Partial
        } else {
            RecallCoverageState::Ok
        },
        candidates: selection.ranked.len(),
        codes,
    }
}

/// Vector coverage: the searched candidates, or why the lane is unavailable.
fn vector_lane(
    input: &RecallRequest,
    selection: &Selection,
    vector: &VectorFacts,
    vector_partial: bool,
) -> RecallCoverageLane {
    if !input.include_vector {
        return disabled();
    }
    if !vector.searched {
        return RecallCoverageLane {
            state: RecallCoverageState::Unavailable,
            candidates: 0,
            codes: vec![
                vector
                    .code
                    .clone()
                    .unwrap_or_else(|| "embedding_not_configured".into()),
            ],
        };
    }
    RecallCoverageLane {
        state: if vector_partial {
            RecallCoverageState::Partial
        } else {
            RecallCoverageState::Ok
        },
        candidates: selection
            .vector_current
            .as_ref()
            .map_or(vector.candidates, |current| {
                current.nodes.len() + current.episodes.len()
            }),
        codes: if vector_partial {
            vec!["vector_current_rows_missing".into()]
        } else {
            vec![]
        },
    }
}

/// Source coverage: hydrated sources, partial for failed or deadline-cut
/// sources and for an envelope-trimmed page.
fn source_lane(selection: &Selection, binding: &Binding, budget_hit: bool) -> RecallCoverageLane {
    let mut codes = selection.coverage.codes.clone();
    if !binding.failed_sources.is_empty() {
        codes.push("source_resolution_failed".into());
    }
    if binding.source_deadline_hit {
        codes.push("operation_deadline".into());
    }
    if budget_hit {
        codes.push("serialization_budget".into());
    }
    RecallCoverageLane {
        state: if codes.is_empty() {
            RecallCoverageState::Ok
        } else {
            RecallCoverageState::Partial
        },
        candidates: binding.hydrated_count,
        codes,
    }
}

fn derive_status(results: usize, outcome: Outcome) -> RecallStatus {
    match outcome {
        Outcome::Failed if results == 0 => RecallStatus::Unavailable,
        Outcome::Failed | Outcome::Partial => RecallStatus::Partial,
        Outcome::Complete => RecallStatus::Complete,
    }
}
