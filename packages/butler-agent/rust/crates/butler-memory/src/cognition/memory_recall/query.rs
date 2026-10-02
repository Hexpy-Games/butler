//! One blocking, pinned graph/canonical read after all async prework has settled.
//!
//! Both page kinds open the generation's graph and canonical snapshot, read,
//! then close them (a close failure wins over the read's own result).

use std::{path::Path, time::Instant};

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
    graph::GraphRecallReader,
    recall::{RecallRequest, RecallResponse},
};
use butler_turn::conversation::ConversationSourceReader;

use super::{
    Clocks, binding, continuation,
    cursor::{CursorStore, Page},
    metrics::{self, RecallMetric, RecallMetricSink},
    response::{self, VectorFacts},
    selection::{self, Selection},
};
use crate::cognition::CognitionCode;

/// What a page read is for.
#[derive(Clone, Copy)]
pub(super) struct PageRead<'a> {
    pub data_root: &'a Path,
    pub environment: &'a CognitionPathEnvironment,
    pub generation: &'a MemoryGenerationHandle,
    pub input: &'a RecallRequest,
    pub cursors: &'a CursorStore,
    pub deadline_at: i64,
}

/// The pinned sources of one read.
struct Sources<'a> {
    graph: &'a GraphRecallReader,
    canonical: Option<&'a ConversationSourceReader>,
    now_iso: &'a str,
}

/// Selects, binds and publishes the first page, reporting stage and
/// candidate metrics to `metrics`.
pub(super) fn initial(
    read: &PageRead<'_>,
    vector: &VectorFacts,
    metrics: Option<&dyn RecallMetricSink>,
    clocks: Clocks<'_>,
) -> CognitionResult<RecallResponse> {
    pinned(read, clocks, |sources| {
        let selected = select(read, &sources, vector, metrics, clocks)?;
        if selected.empty_search {
            return Ok(response::empty(
                read.input,
                &selected,
                vector,
                (clocks.now_millis)() >= read.deadline_at,
            ));
        }
        let memory_root = read.environment.memory_root(read.data_root);
        let source_started = Instant::now();
        let bound = binding::run(
            &binding::BindingInput {
                graph: sources.graph,
                canonical: sources.canonical,
                data_root: &read.generation.source_root,
                memory_root: &memory_root,
                generation_id: &read.generation.generation_id,
                input: read.input,
                selection: &selected,
                deadline_at: read.deadline_at,
                now_iso: sources.now_iso,
            },
            clocks,
            || {
                record_stage(
                    metrics,
                    read.input,
                    "recall_v2_source_hydration",
                    source_started,
                );
            },
        )?;
        let response = response::initial(
            &response::FirstPage {
                graph: sources.graph,
                input: read.input,
                generation_id: &read.generation.generation_id,
                selection: &selected,
                binding: &bound,
                vector,
                deadline_at: read.deadline_at,
                now_iso: sources.now_iso,
            },
            read.cursors,
            clocks,
        )?;
        record_returned(metrics, read, &selected, &response);
        Ok(response)
    })
}

/// Continues the cursor `page` against a fresh pin.
pub(super) fn continue_page(
    read: &PageRead<'_>,
    page: &Page,
    clocks: Clocks<'_>,
) -> CognitionResult<RecallResponse> {
    pinned(read, clocks, |sources| {
        let memory_root = read.environment.memory_root(read.data_root);
        continuation::run(
            continuation::ContinuationInput {
                graph: sources.graph,
                canonical: sources.canonical,
                source_root: &read.generation.source_root,
                memory_root: &memory_root,
                generation_id: &read.generation.generation_id,
                input: read.input,
                page,
                deadline_at: read.deadline_at,
                now_iso: sources.now_iso,
            },
            read.cursors,
            clocks,
        )
    })
}

/// Runs `body` over the generation's opened sources and closes them.
fn pinned(
    read: &PageRead<'_>,
    clocks: Clocks<'_>,
    body: impl FnOnce(Sources<'_>) -> CognitionResult<RecallResponse>,
) -> CognitionResult<RecallResponse> {
    let (canonical, graph) = open_sources(read.generation)?;
    let result = butler_core::js_date::format_iso_millis((clocks.now_millis)())
        .ok_or_else(|| CognitionError::new(CognitionCode::InvalidArguments, "invalid_arguments"))
        .and_then(|now_iso| {
            let mut response = body(Sources {
                graph: &graph,
                canonical: canonical.as_ref(),
                now_iso: &now_iso,
            })?;
            response.detail_pin = Some(super::details::DetailPin::new(
                read.generation,
                &graph,
                canonical.as_ref(),
            )?);
            Ok(response)
        });
    close_sources(graph, canonical, result)
}

/// Candidate selection within the graph and candidate deadlines (2 s and
/// 3.5 s before the operation deadline).
fn select(
    read: &PageRead<'_>,
    sources: &Sources<'_>,
    vector: &VectorFacts,
    metrics: Option<&dyn RecallMetricSink>,
    clocks: Clocks<'_>,
) -> CognitionResult<Selection> {
    let graph_started = Instant::now();
    let graph_deadline = read.deadline_at - 2_000;
    let memory_root = read.environment.memory_root(read.data_root);
    let selected = selection::run(selection::RecallSelectionInput {
        graph: sources.graph,
        canonical: sources.canonical,
        data_root: read.data_root,
        memory_root: &memory_root,
        generation: read.generation,
        input: read.input,
        vector_matches: vector.matches.as_ref(),
        candidate_deadline: graph_deadline - 1_500,
        graph_deadline,
        overall_deadline: read.deadline_at,
        now_iso: sources.now_iso,
        now_millis: clocks.now_millis,
        parse_date: clocks.parse_date,
        compare_locale: clocks.compare_locale,
    })?;
    record_stage(
        metrics,
        read.input,
        "recall_v2_graph_read_ppr",
        graph_started,
    );
    if let Some(sink) = metrics {
        for (index, candidate) in selected.metrics.iter().enumerate() {
            sink.record(metrics::candidate(
                read.input,
                &read.generation.generation_id,
                index + 1,
                candidate,
                selected.executed,
            ));
        }
    }
    Ok(selected)
}

fn record_stage(
    metrics: Option<&dyn RecallMetricSink>,
    input: &RecallRequest,
    name: &'static str,
    started: Instant,
) {
    if let Some(sink) = metrics {
        sink.record(RecallMetric::Stage {
            name,
            native_operation_sha256: metrics::sha(&input.runtime.native_operation_id),
            duration_ms: started.elapsed().as_secs_f64() * 1_000.0,
        });
    }
}

/// One `returned` metric per delivered result, with its candidate rank.
fn record_returned(
    metrics: Option<&dyn RecallMetricSink>,
    read: &PageRead<'_>,
    selected: &Selection,
    response: &RecallResponse,
) {
    let Some(sink) = metrics else {
        return;
    };
    for (index, item) in response.results.iter().enumerate() {
        let rank = selected
            .metrics
            .iter()
            .position(|candidate| candidate.episode_id == item.episode_ref)
            .map_or(0, |rank| rank + 1);
        sink.record(metrics::returned(
            read.input,
            &read.generation.generation_id,
            rank,
            index + 1,
            &item.episode_ref,
            selected.executed,
        ));
    }
}

pub(super) fn open_sources(
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
                    CognitionCode::CanonicalSourceUnavailable,
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

pub(super) fn close_sources<T>(
    graph: GraphRecallReader,
    canonical: Option<ConversationSourceReader>,
    result: CognitionResult<T>,
) -> CognitionResult<T> {
    let graph_close = graph.close();
    let canonical_close = canonical
        .map(ConversationSourceReader::close)
        .transpose()
        .map_err(|error| {
            CognitionError::new(CognitionCode::CanonicalSourceUnavailable, error.to_string())
                .with_source(error)
        });
    graph_close.and(canonical_close).and(result)
}
