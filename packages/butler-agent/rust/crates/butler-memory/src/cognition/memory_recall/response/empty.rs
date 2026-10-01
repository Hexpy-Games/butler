//! Recall responses without results: disabled or unavailable lanes, or nothing selected.

use super::*;

/// The response of a search without any seed, temporal, vector or raw hit.
pub(crate) fn empty(
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
    let execution = deadline_hit
        || selection
            .coverage
            .codes
            .iter()
            .any(|code| code == "canonical_source_unavailable")
        || (vector_execution && !admitted.graph && !admitted.lexical);
    let outcome = if execution {
        Outcome::Failed
    } else if graph_execution || vector_execution {
        Outcome::Partial
    } else {
        Outcome::Complete
    };
    RecallResponse {
        status: derive_status(0, outcome),
        results: vec![],
        coverage: RecallCoverage {
            graph: if admitted.graph {
                empty_graph_lane(selection, deadline_hit)
            } else {
                disabled()
            },
            vectors: if vector_requested {
                empty_vector_lane(vector, code, vector_partial)
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

/// Graph coverage of an empty search: its codes plus `no_hits`.
pub(super) fn empty_graph_lane(selection: &Selection, deadline_hit: bool) -> RecallCoverageLane {
    let mut codes = selection.coverage.codes.clone();
    codes.extend(selection.selection_codes.iter().cloned());
    if deadline_hit {
        codes.push("operation_deadline".into());
    }
    codes.push("no_hits".into());
    RecallCoverageLane {
        state: if codes.len() > 1 {
            RecallCoverageState::Partial
        } else {
            RecallCoverageState::Ok
        },
        candidates: 0,
        codes,
    }
}

/// Vector coverage of an empty search: `no_hits` after a clean search, or
/// why the lane is unavailable.
pub(super) fn empty_vector_lane(
    vector: &VectorFacts,
    code: Option<&str>,
    vector_partial: bool,
) -> RecallCoverageLane {
    if code != Some("no_hits") {
        return RecallCoverageLane {
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
        };
    }
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
}

pub(super) fn disabled() -> RecallCoverageLane {
    RecallCoverageLane {
        state: RecallCoverageState::DisabledByRequest,
        candidates: 0,
        codes: vec![],
    }
}
