//! Coverage, complete-bundle envelope and first-page cursor publication.

use serde::Serialize;
use std::cmp::Ordering;

use crate::cognition::{
    CognitionResult,
    graph::GraphRecallReader,
    recall::{
        RecallCoverage, RecallCoverageLane, RecallCoverageState, RecallRequest, RecallResponse,
        RecallResultItem, RecallStatus,
    },
};

use super::{
    binding::{self, Binding},
    cursor::{self, CursorStore},
    envelope,
    selection::Selection,
};

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
            status: self.status,
            results: self.results.to_vec(),
            coverage: self.coverage,
            next_cursor: self.next_cursor,
            diagnostics: self.diagnostics,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn initial(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    generation_id: &str,
    selection: &Selection,
    binding: &Binding,
    vector: &VectorFacts,
    cursors: &CursorStore,
    deadline_at: i64,
    now_iso: &str,
    now_millis: &impl Fn() -> i64,
    parse_date: &impl Fn(&str) -> f64,
    compare_locale: &impl Fn(&str, &str) -> Ordering,
) -> CognitionResult<RecallResponse> {
    if selection.empty_search {
        return Ok(empty(input, selection, vector, now_millis() >= deadline_at));
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
        generation_id,
        graph.revision(),
        metadata,
        now_millis(),
    )?;
    let mut results = Vec::<RecallResultItem>::new();
    let mut result_offsets = Vec::<usize>::new();
    let mut next_offset = 0usize;
    let mut budget_hit = false;
    for (index, candidate) in binding.candidates.iter().enumerate() {
        let minimum = envelope::minimum(
            &candidate.item,
            |evidence| {
                binding::rebind(binding::RecallRebindInput {
                    graph,
                    input,
                    selection,
                    binding,
                    original: &candidate.item,
                    evidence,
                    now_iso,
                    parse_date,
                })
            },
            compare_locale,
        )?;
        results.push(minimum);
        result_offsets.push(index);
        next_offset = index + 1;
        if envelope::bytes(&build(
            input,
            selection,
            binding,
            vector,
            &results,
            &page.key,
            next_offset,
            page.inventory.candidates.len(),
            budget_hit,
            now_millis() >= deadline_at,
        ))? > envelope::MAX_BYTES
        {
            results.pop();
            result_offsets.pop();
            budget_hit = true;
            if !results.is_empty() {
                next_offset = index;
                break;
            }
            continue;
        }
        if results.len() >= input.limit {
            break;
        }
    }
    for (index, offset) in result_offsets.iter().copied().enumerate() {
        let minimum =
            std::mem::replace(&mut results[index], binding.candidates[offset].item.clone());
        if envelope::bytes(&build(
            input,
            selection,
            binding,
            vector,
            &results,
            &page.key,
            next_offset,
            page.inventory.candidates.len(),
            budget_hit,
            now_millis() >= deadline_at,
        ))? > envelope::MAX_BYTES
        {
            results[index] = minimum;
        }
    }
    let response = build(
        input,
        selection,
        binding,
        vector,
        &results,
        &page.key,
        next_offset,
        page.inventory.candidates.len(),
        budget_hit,
        now_millis() >= deadline_at,
    )
    .into_owned();
    cursors.update(&page.key, &response)?;
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
fn build<'a>(
    input: &RecallRequest,
    selection: &Selection,
    binding: &Binding,
    vector: &VectorFacts,
    results: &'a [RecallResultItem],
    key: &str,
    next_offset: usize,
    candidate_count: usize,
    budget_hit: bool,
    deadline_hit: bool,
) -> ResponseView<'a> {
    let admitted = input.admitted_channels.clone().unwrap_or_default();
    let next_cursor = (next_offset < candidate_count).then(|| cursor::encode(key, next_offset));
    let graph_codes = selection
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
    let mut source_codes = selection.coverage.codes.clone();
    if !binding.failed_sources.is_empty() {
        source_codes.push("source_resolution_failed".into());
    }
    if binding.source_deadline_hit {
        source_codes.push("operation_deadline".into());
    }
    if budget_hit {
        source_codes.push("serialization_budget".into());
    }
    let vector_partial =
        vector.partial || selection.vector_current.as_ref().is_some_and(|v| v.partial);
    let partial = selection.coverage.pending
        || !selection.coverage.codes.is_empty()
        || !binding.failed_sources.is_empty()
        || binding.source_deadline_hit
        || budget_hit
        || !selection.selection_codes.is_empty()
        || !selection.expansion.coverage_codes.is_empty()
        || vector_partial
        || selection.candidate_limit
        || deadline_hit
        || vector.code.is_some();
    let execution_incomplete = partial;
    ResponseView {
        status: derive_status(results.len(), partial, execution_incomplete),
        results,
        coverage: RecallCoverage {
            graph: if admitted.graph {
                RecallCoverageLane {
                    state: if selection.coverage.pending || !graph_codes.is_empty() {
                        RecallCoverageState::Partial
                    } else {
                        RecallCoverageState::Ok
                    },
                    candidates: selection.ranked.len(),
                    codes: graph_codes,
                }
            } else {
                disabled()
            },
            vectors: if input.include_vector {
                if vector.searched {
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
                } else {
                    RecallCoverageLane {
                        state: RecallCoverageState::Unavailable,
                        candidates: 0,
                        codes: vec![
                            vector
                                .code
                                .clone()
                                .unwrap_or_else(|| "embedding_not_configured".into()),
                        ],
                    }
                }
            } else {
                disabled()
            },
            source: RecallCoverageLane {
                state: if source_codes.is_empty() {
                    RecallCoverageState::Ok
                } else {
                    RecallCoverageState::Partial
                },
                candidates: binding.hydrated_count,
                codes: source_codes,
            },
        },
        next_cursor,
        diagnostics: vector.diagnostics.clone(),
    }
}

pub(super) fn empty(
    input: &RecallRequest,
    selection: &Selection,
    vector: &VectorFacts,
    deadline_hit: bool,
) -> RecallResponse {
    let admitted = input.admitted_channels.clone().unwrap_or_default();
    let vector_requested = input.include_vector && admitted.vector;
    let code = if vector.searched && vector.code.is_none() {
        Some("no_hits")
    } else {
        vector.code.as_deref()
    };
    let vector_partial = selection.vector_current.as_ref().is_some_and(|v| v.partial)
        || vector.diagnostics.iter().any(|code| {
            code.contains("_omitted=")
                || code.ends_with("_vector_bound_reached")
                || code.starts_with("vector_rows_invalid=")
        });
    let graph_execution = !selection.coverage.codes.is_empty()
        || !selection.selection_codes.is_empty()
        || deadline_hit;
    let vector_execution =
        vector_requested && (code != Some("no_hits") || vector_partial || vector.partial);
    let partial = graph_execution || vector_execution;
    let execution = deadline_hit
        || selection
            .coverage
            .codes
            .iter()
            .any(|code| code == "canonical_source_unavailable")
        || (vector_execution && !admitted.graph && !admitted.lexical);
    let mut graph_codes = selection.coverage.codes.clone();
    graph_codes.extend(selection.selection_codes.iter().cloned());
    if deadline_hit {
        graph_codes.push("operation_deadline".into());
    }
    RecallResponse {
        status: derive_status(0, partial, execution),
        results: vec![],
        coverage: RecallCoverage {
            graph: if admitted.graph {
                graph_codes.push("no_hits".into());
                RecallCoverageLane {
                    state: if graph_codes.len() > 1 {
                        RecallCoverageState::Partial
                    } else {
                        RecallCoverageState::Ok
                    },
                    candidates: 0,
                    codes: graph_codes,
                }
            } else {
                disabled()
            },
            vectors: if vector_requested {
                if code == Some("no_hits") {
                    RecallCoverageLane {
                        state: if vector_partial || vector.partial {
                            RecallCoverageState::Partial
                        } else {
                            RecallCoverageState::Ok
                        },
                        candidates: 0,
                        codes: vector
                            .diagnostics
                            .iter()
                            .cloned()
                            .chain(
                                vector
                                    .partial
                                    .then_some("vector_current_rows_missing".into()),
                            )
                            .chain(std::iter::once("no_hits".into()))
                            .collect(),
                    }
                } else {
                    RecallCoverageLane {
                        state: RecallCoverageState::Unavailable,
                        candidates: 0,
                        codes: std::iter::once(
                            vector
                                .code
                                .clone()
                                .unwrap_or_else(|| "embedding_not_configured".into()),
                        )
                        .chain(vector.diagnostics.iter().cloned())
                        .collect(),
                    }
                }
            } else {
                disabled()
            },
            source: RecallCoverageLane {
                state: if selection.coverage.codes.is_empty() {
                    RecallCoverageState::Ok
                } else {
                    RecallCoverageState::Partial
                },
                candidates: 0,
                codes: selection.coverage.codes.clone(),
            },
        },
        next_cursor: None,
        diagnostics: vector.diagnostics.clone(),
    }
}

fn disabled() -> RecallCoverageLane {
    RecallCoverageLane {
        state: RecallCoverageState::DisabledByRequest,
        candidates: 0,
        codes: vec![],
    }
}
fn derive_status(results: usize, partial: bool, execution: bool) -> RecallStatus {
    if results == 0 && execution {
        RecallStatus::Unavailable
    } else if partial {
        RecallStatus::Partial
    } else {
        RecallStatus::Complete
    }
}
