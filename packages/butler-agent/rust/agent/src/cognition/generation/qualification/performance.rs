use std::collections::{HashMap, HashSet};

use crate::cognition::CognitionResult;

use super::{
    CaptureStore,
    case::same_string_set,
    invalid,
    io::{self, valid_sha},
    source::{self, ReturnedResult},
    types::{
        Acceptance, ContentionEvidence, PerformanceMetrics, PerformanceReport, PerformanceSample,
        QueryResult, QueueWorkEvidence, SourceBinding, SourceRead,
    },
};

pub(super) fn validate_performance(
    acceptance: &Acceptance,
    capture: &mut CaptureStore,
) -> CognitionResult<()> {
    let performance = &acceptance.performance;
    if performance.graph_samples != 60
        || performance.hybrid_samples != 60
        || !performance.prepared_graph_p95_ms.is_finite()
        || performance.prepared_graph_p95_ms > 500.0
        || !performance.prepared_hybrid_p95_ms.is_finite()
        || performance.prepared_hybrid_p95_ms > 1_500.0
        || !io::safe_ref(&performance.report_ref)
        || !valid_sha(&performance.report_sha256)
    {
        return Err(invalid("memory_acceptance_performance_invalid"));
    }

    let report: PerformanceReport =
        capture.read_json(&performance.report_ref, &performance.report_sha256)?;
    let graph = report
        .samples
        .iter()
        .filter(|sample| sample.mode == "graph")
        .collect::<Vec<_>>();
    let hybrid = report
        .samples
        .iter()
        .filter(|sample| sample.mode == "hybrid")
        .collect::<Vec<_>>();
    let first_trace: super::types::CaseTrace = capture.read_json(
        &acceptance.cases[0].trace_ref,
        &acceptance.cases[0].trace_sha256,
    )?;
    let inventory: serde_json::Value = capture.read_json(
        &first_trace.qualification_source_inventory_ref,
        &first_trace.qualification_source_inventory_sha256,
    )?;

    if report.schema != "butler.memory-recovery-performance.v1"
        || report.execution.generation_id != acceptance.verification_generation_id
        || report.execution.implementation_commit != acceptance.implementation_commit
        || report.execution.embedding_version != acceptance.embedding_version
        || report.execution.qualification_source_inventory_hash
            != acceptance.verification_source_inventory_hash
        || graph.len() != 60
        || hybrid.len() != 60
        || source::memory_inventory_hash(&inventory)?
            != acceptance.verification_source_inventory_hash
    {
        return Err(invalid("memory_acceptance_performance_invalid"));
    }

    for sample in &report.samples {
        if !valid_performance_sample(sample) {
            return Err(invalid("memory_acceptance_performance_invalid"));
        }
        let artifacts_valid = valid_performance_artifacts(
            sample,
            &report.execution.generation_id,
            &acceptance.verification_source_inventory_hash,
            &inventory,
            capture,
        )
        .map_err(|_| invalid("memory_acceptance_performance_invalid"))?;
        if !artifacts_valid {
            return Err(invalid("memory_acceptance_performance_invalid"));
        }
    }
    if !valid_twelve_by_five(&graph)
        || !valid_twelve_by_five(&hybrid)
        || report
            .samples
            .iter()
            .map(|sample| sample.result_id.as_str())
            .collect::<HashSet<_>>()
            .len()
            != 120
        || !same_performance_queries(&graph, &hybrid)
        || percentile95(
            &graph
                .iter()
                .map(|sample| sample.elapsed_ms)
                .collect::<Vec<_>>(),
        ) != performance.prepared_graph_p95_ms
        || percentile95(
            &hybrid
                .iter()
                .map(|sample| sample.elapsed_ms)
                .collect::<Vec<_>>(),
        ) != performance.prepared_hybrid_p95_ms
        || !valid_contention_evidence(&report.contention, capture, &report.samples)?
    {
        return Err(invalid("memory_acceptance_performance_invalid"));
    }
    Ok(())
}

fn valid_performance_sample(sample: &PerformanceSample) -> bool {
    !sample.query_id.is_empty()
        && (1..=5).contains(&sample.repetition)
        && !sample.result_id.is_empty()
        && valid_sha(&sample.query_hash)
        && io::safe_ref(&sample.result_ref)
        && valid_sha(&sample.result_sha256)
        && io::safe_ref(&sample.metrics_ref)
        && valid_sha(&sample.metrics_sha256)
        && matches!(sample.status.as_str(), "ok" | "partial")
        && sample.elapsed_ms.is_finite()
        && sample.elapsed_ms >= 0.0
        && sample.coverage_ok
        && !sample.expected_source_groups.is_empty()
        && sample
            .expected_source_groups
            .iter()
            .all(|group| !group.is_empty())
        && !sample.source_binding_refs.is_empty()
        && sample.expected_source_groups.iter().all(|group| {
            group
                .iter()
                .any(|handle| sample.observed_source_handles.contains(handle))
        })
}

fn valid_twelve_by_five(samples: &[&PerformanceSample]) -> bool {
    let mut by_query = HashMap::<&str, HashSet<u32>>::new();
    for sample in samples {
        by_query
            .entry(sample.query_id.as_str())
            .or_default()
            .insert(sample.repetition);
    }
    by_query.len() == 12
        && by_query.values().all(|repetitions| {
            repetitions.len() == 5 && (1..=5).all(|value| repetitions.contains(&value))
        })
}

fn valid_performance_artifacts(
    sample: &PerformanceSample,
    generation_id: &str,
    inventory_hash: &str,
    inventory: &serde_json::Value,
    capture: &mut CaptureStore,
) -> CognitionResult<bool> {
    let result: QueryResult = capture.read_json(&sample.result_ref, &sample.result_sha256)?;
    let metrics: PerformanceMetrics =
        capture.read_json(&sample.metrics_ref, &sample.metrics_sha256)?;
    let mut evidence = Vec::<(SourceBinding, SourceRead)>::new();
    for reference in &sample.source_binding_refs {
        let binding: SourceBinding = capture.read_json(reference.path(), &reference.sha256)?;
        let read: SourceRead =
            capture.read_json(&binding.read_result_ref, &binding.read_result_sha256)?;
        evidence.push((binding, read));
    }
    if result.schema != "butler.memory-query-result-evidence.v1"
        || result.generation_id != generation_id
        || result.result_id != sample.result_id
        || result.query_hash != sample.query_hash
        || result.status != sample.status
        || !same_string_set(&result.source_handles, &sample.observed_source_handles)
        || metrics.schema != "butler.memory-performance-metrics-evidence.v1"
        || metrics.mode != sample.mode
        || metrics.query_id != sample.query_id
        || metrics.repetition != sample.repetition
        || metrics.result_id != sample.result_id
        || metrics.query_hash != sample.query_hash
        || metrics.status != sample.status
        || metrics.elapsed_ms != sample.elapsed_ms
    {
        return Ok(false);
    }
    let returned = ReturnedResult {
        result_id: &result.result_id,
        source_handles: &result.source_handles,
        observations: &result.observations,
    };
    for handle in &sample.observed_source_handles {
        let matching = evidence
            .iter()
            .filter(|(binding, read)| {
                binding.handle == *handle
                    && binding.returned_in_result_id == sample.result_id
                    && source::binding_returned_by_result(binding, &returned)
                    && source::valid_source_read_evidence(binding, read)
                    && source::source_binding_belongs_to_inventory(
                        binding,
                        inventory,
                        generation_id,
                    )
                    && binding.inventory_hash == inventory_hash
            })
            .count();
        if matching != 1 {
            return Ok(false);
        }
    }
    Ok(evidence
        .iter()
        .all(|(binding, _)| sample.observed_source_handles.contains(&binding.handle)))
}

fn same_performance_queries(graph: &[&PerformanceSample], hybrid: &[&PerformanceSample]) -> bool {
    signatures(graph) == signatures(hybrid)
        && graph.iter().chain(hybrid).all(|sample| {
            graph
                .iter()
                .chain(hybrid)
                .filter(|candidate| candidate.query_id == sample.query_id)
                .all(|candidate| candidate.query_hash == sample.query_hash)
        })
}

fn signatures(samples: &[&PerformanceSample]) -> Vec<(String, String)> {
    let mut values = samples
        .iter()
        .map(|sample| (sample.query_id.clone(), sample.query_hash.clone()))
        .collect::<Vec<_>>();
    values.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    values.dedup_by(|left, right| left.0 == right.0);
    values
}

fn percentile95(values: &[f64]) -> f64 {
    if values.is_empty()
        || values
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
    {
        return f64::NAN;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = (sorted.len() as f64 * 0.95).ceil() as usize - 1;
    sorted[index]
}

fn valid_contention_evidence(
    value: &ContentionEvidence,
    capture: &mut CaptureStore,
    samples: &[PerformanceSample],
) -> CognitionResult<bool> {
    let prepared_query_ids = samples
        .iter()
        .map(|sample| sample.query_id.as_str())
        .collect::<HashSet<_>>();
    if !value.overlapped
        || value.source_window_ids.iter().collect::<HashSet<_>>().len() != 4
        || !same_string_set(
            &value
                .query_intervals
                .iter()
                .map(|query| query.query_id.clone())
                .collect::<Vec<_>>(),
            &prepared_query_ids
                .iter()
                .map(|id| (*id).to_owned())
                .collect::<Vec<_>>(),
        )
        || value.query_intervals.iter().any(|query| {
            query.query_id.is_empty()
                || !prepared_query_ids.contains(query.query_id.as_str())
                || !ordered_interval(&query.started_at, &query.ended_at)
        })
        || value.queue_work_refs.iter().any(|work| {
            work.result_id.is_empty()
                || !ordered_interval(&work.started_at, &work.ended_at)
                || work.source_window_ids.is_empty()
        })
        || !same_string_set(
            &value.source_window_ids,
            &value
                .queue_work_refs
                .iter()
                .flat_map(|work| work.source_window_ids.iter().cloned())
                .collect::<Vec<_>>(),
        )
    {
        return Ok(false);
    }

    let mut queue_work = Vec::with_capacity(value.queue_work_refs.len());
    for work in &value.queue_work_refs {
        let evidence: QueueWorkEvidence = capture
            .read_json(work.evidence.path(), &work.evidence.sha256)
            .map_err(|_| invalid("memory_acceptance_performance_invalid"))?;
        if evidence.schema != "butler.memory-queue-work-evidence.v1"
            || evidence.result_id != work.result_id
            || evidence.work_class != "background"
            || evidence.started_at != work.started_at
            || evidence.ended_at != work.ended_at
            || !same_string_set(&evidence.source_window_ids, &work.source_window_ids)
        {
            return Ok(false);
        }
        queue_work.push(work);
    }
    Ok(value.query_intervals.iter().any(|query| {
        queue_work.iter().any(|work| {
            let (Some(query_start), Some(query_end), Some(work_start), Some(work_end)) = (
                source::timestamp_millis(&query.started_at),
                source::timestamp_millis(&query.ended_at),
                source::timestamp_millis(&work.started_at),
                source::timestamp_millis(&work.ended_at),
            ) else {
                return false;
            };
            query_start < work_end && work_start < query_end
        })
    }))
}

fn ordered_interval(start: &str, end: &str) -> bool {
    matches!(
        (
            source::timestamp_millis(start),
            source::timestamp_millis(end)
        ),
        (Some(start), Some(end)) if start < end
    )
}
