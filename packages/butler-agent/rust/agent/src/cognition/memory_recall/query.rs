//! One blocking, pinned graph/canonical read after all async prework has settled.

use std::{cmp::Ordering, path::Path, time::Instant};

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
    graph::GraphRecallReader,
    recall::{RecallRequest, RecallResponse},
};
use crate::conversation::ConversationSourceReader;

use super::{
    binding, continuation,
    cursor::{CursorStore, Page},
    metrics::{self, RecallMetric, RecallMetricSink},
    response::{self, VectorFacts},
    selection,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn initial(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation: &MemoryGenerationHandle,
    input: &RecallRequest,
    vector: &VectorFacts,
    cursors: &CursorStore,
    metrics: Option<&dyn RecallMetricSink>,
    deadline_at: i64,
    now_millis: &impl Fn() -> i64,
    parse_date: &impl Fn(&str) -> f64,
    compare_locale: &impl Fn(&str, &str) -> Ordering,
) -> CognitionResult<RecallResponse> {
    let (canonical, graph) = open_sources(generation)?;
    let now_iso = crate::js_date::format_iso_millis(now_millis())
        .ok_or_else(|| CognitionError::new("invalid_arguments", "invalid_arguments"));
    let result = now_iso.and_then(|now_iso| {
        let graph_started = Instant::now();
        let graph_deadline = deadline_at - 2_000;
        let candidate_deadline = graph_deadline - 1_500;
        let memory_root = environment.memory_root(data_root);
        let selected = selection::run(selection::RecallSelectionInput {
            graph: &graph,
            canonical: canonical.as_ref(),
            data_root,
            memory_root: &memory_root,
            generation,
            input,
            vector_matches: vector.matches.as_ref(),
            candidate_deadline,
            graph_deadline,
            overall_deadline: deadline_at,
            now_iso: &now_iso,
            now_millis,
            parse_date,
            compare_locale,
        })?;
        if let Some(sink) = metrics {
            sink.record(RecallMetric::Stage {
                name: "recall_v2_graph_read_ppr",
                native_operation_sha256: metrics::sha(&input.runtime.native_operation_id),
                duration_ms: graph_started.elapsed().as_secs_f64() * 1_000.0,
            });
            for (index, candidate) in selected.metrics.iter().enumerate() {
                sink.record(metrics::candidate(
                    input,
                    &generation.generation_id,
                    index + 1,
                    candidate,
                    selected.executed,
                ));
            }
        }
        if selected.empty_search {
            return Ok(response::empty(
                input,
                &selected,
                vector,
                now_millis() >= deadline_at,
            ));
        }
        let source_started = Instant::now();
        let bound = binding::run(
            &graph,
            canonical.as_ref(),
            &generation.source_root,
            &environment.memory_root(data_root),
            &generation.generation_id,
            input,
            &selected,
            deadline_at,
            &now_iso,
            now_millis,
            parse_date,
            compare_locale,
            || {
                if let Some(sink) = metrics {
                    sink.record(RecallMetric::Stage {
                        name: "recall_v2_source_hydration",
                        native_operation_sha256: metrics::sha(&input.runtime.native_operation_id),
                        duration_ms: source_started.elapsed().as_secs_f64() * 1_000.0,
                    });
                }
            },
        )?;
        let response = response::initial(
            &graph,
            input,
            &generation.generation_id,
            &selected,
            &bound,
            vector,
            cursors,
            deadline_at,
            &now_iso,
            now_millis,
            parse_date,
            compare_locale,
        )?;
        if let Some(sink) = metrics {
            for (index, item) in response.results.iter().enumerate() {
                let rank = selected
                    .metrics
                    .iter()
                    .position(|candidate| candidate.episode_id == item.episode_ref)
                    .map_or(0, |rank| rank + 1);
                sink.record(metrics::returned(
                    input,
                    &generation.generation_id,
                    rank,
                    index + 1,
                    &item.episode_ref,
                    selected.executed,
                ));
            }
        }
        Ok(response)
    });
    close_sources(graph, canonical, result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn continue_page(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation: &MemoryGenerationHandle,
    input: &RecallRequest,
    page: &Page,
    cursors: &CursorStore,
    deadline_at: i64,
    now_millis: &impl Fn() -> i64,
    parse_date: &impl Fn(&str) -> f64,
    compare_locale: &impl Fn(&str, &str) -> Ordering,
) -> CognitionResult<RecallResponse> {
    let (canonical, graph) = open_sources(generation)?;
    let now_iso = crate::js_date::format_iso_millis(now_millis())
        .ok_or_else(|| CognitionError::new("invalid_arguments", "invalid_arguments"));
    let result = now_iso.and_then(|now_iso| {
        continuation::run(
            &graph,
            canonical.as_ref(),
            &generation.source_root,
            &environment.memory_root(data_root),
            &generation.generation_id,
            input,
            page,
            cursors,
            deadline_at,
            &now_iso,
            now_millis,
            parse_date,
            compare_locale,
        )
    });
    close_sources(graph, canonical, result)
}

fn open_sources(
    generation: &MemoryGenerationHandle,
) -> CognitionResult<(Option<ConversationSourceReader>, GraphRecallReader)> {
    let canonical_path = generation
        .canonical_snapshot_path
        .clone()
        .unwrap_or_else(|| {
            generation
                .source_root
                .join("runtime/conversation-store.sqlite")
        });
    let canonical = if canonical_path.exists() {
        match ConversationSourceReader::open(&canonical_path) {
            Ok(reader) => Some(reader),
            Err(error) if error.code() == "conversation_source_schema_unavailable" => None,
            Err(error) => {
                return Err(CognitionError::new(
                    "canonical_source_unavailable",
                    error.to_string(),
                ));
            }
        }
    } else {
        None
    };
    let graph = GraphRecallReader::open(&generation.graph_path)?;
    Ok((canonical, graph))
}

fn close_sources(
    graph: GraphRecallReader,
    canonical: Option<ConversationSourceReader>,
    result: CognitionResult<RecallResponse>,
) -> CognitionResult<RecallResponse> {
    let graph_close = graph.close();
    let canonical_close = canonical
        .map(ConversationSourceReader::close)
        .transpose()
        .map_err(|error| CognitionError::new("canonical_source_unavailable", error.to_string()));
    graph_close.and(canonical_close).and(result)
}
