use std::collections::HashSet;

use crate::cognition::CognitionResult;

use super::{
    CaptureStore, invalid,
    source::{self, ReturnedResult},
    types::{
        Acceptance, AcceptanceCase, CaseTrace, EmbeddingExecution, EvidenceRef, OwnerResult,
        QueryResult,
    },
};

pub(super) fn validate_case(
    item: &AcceptanceCase,
    acceptance: &Acceptance,
    capture: &mut CaptureStore,
) -> CognitionResult<()> {
    if item.id.is_empty()
        || item.outcome != "passed"
        || !matches!(
            item.path.as_str(),
            "public_app_btcc" | "native_tool" | "owner_integration"
        )
        || !super::io::valid_sha(&item.query_hash)
        || !super::io::valid_sha(&item.trace_sha256)
        || !super::io::safe_ref(&item.trace_ref)
    {
        return Err(invalid("memory_acceptance_invalid"));
    }

    let trace: CaseTrace = capture.read_json(&item.trace_ref, &item.trace_sha256)?;
    let final_inventory: serde_json::Value = capture.read_json(
        &trace.qualification_source_inventory_ref,
        &trace.qualification_source_inventory_sha256,
    )?;
    let execution_inventory: serde_json::Value = capture.read_json(
        &trace.execution.source_inventory_ref,
        &trace.execution.source_inventory_sha256,
    )?;
    let query_results = trace
        .query
        .result_refs
        .iter()
        .map(|reference| {
            let result_id = reference
                .result_id
                .as_deref()
                .ok_or_else(|| invalid("memory_acceptance_evidence_invalid"))?;
            let result: QueryResult = capture.read_json(reference.path(), &reference.sha256)?;
            if result.result_id != result_id {
                return Err(invalid("memory_acceptance_evidence_invalid"));
            }
            Ok(result)
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    let owner_source_refs = trace
        .owner_source_result_refs
        .as_deref()
        .unwrap_or_default();
    let owner_source_results = owner_source_refs
        .iter()
        .map(|reference| {
            let result_id = reference
                .result_id
                .as_deref()
                .ok_or_else(|| invalid("memory_acceptance_evidence_invalid"))?;
            let result: OwnerResult = capture.read_json(reference.path(), &reference.sha256)?;
            if result.result_id != result_id {
                return Err(invalid("memory_acceptance_evidence_invalid"));
            }
            Ok(result)
        })
        .collect::<CognitionResult<Vec<_>>>()?;

    let top_bound = item.path != "owner_integration";
    let observed_results = if top_bound {
        query_results
            .iter()
            .map(|result| ReturnedResult {
                result_id: &result.result_id,
                source_handles: &result.source_handles,
                observations: &result.observations,
            })
            .collect::<Vec<_>>()
    } else {
        owner_source_results
            .iter()
            .map(|result| ReturnedResult {
                result_id: &result.result_id,
                source_handles: &result.source_handles,
                observations: &result.observations,
            })
            .collect::<Vec<_>>()
    };
    let observed_result_ids = observed_results
        .iter()
        .map(|result| result.result_id.to_owned())
        .collect::<Vec<_>>();

    if trace.schema != "butler.memory-recovery-case-trace.v1"
        || !super::io::valid_git_commit(&trace.execution.implementation_commit)
        || trace.execution.implementation_commit != acceptance.implementation_commit
        || trace.execution.tool_contract_version != acceptance.tool_contract_version
        || trace.execution.extraction_version != acceptance.extraction_version
        || !embedding_execution_matches(&trace.execution.embedding, item, acceptance, top_bound)
        || trace.query.sha256 != item.query_hash
        || (top_bound
            && query_results.iter().any(|result| {
                result.schema != "butler.memory-query-result-evidence.v1"
                    || result.query_hash != item.query_hash
                    || result.generation_id != trace.execution.generation_id
                    || Some(result.request_id.as_str()) != trace.query.request_id.as_deref()
                    || !matches!(result.status.as_str(), "ok" | "partial")
            }))
        || (!top_bound
            && owner_source_results
                .iter()
                .enumerate()
                .any(|(index, result)| {
                    result.schema != "butler.memory-owner-result-evidence.v1"
                        || result.generation_id != trace.execution.generation_id
                        || !matches!(result.status.as_str(), "ok" | "partial")
                        || !trace
                            .owner_result_refs
                            .as_deref()
                            .unwrap_or_default()
                            .iter()
                            .any(|reference| {
                                owner_source_refs.get(index).is_some_and(|source_ref| {
                                    reference.ref_ == source_ref.ref_
                                        && reference.sha256 == source_ref.sha256
                                })
                            })
                }))
        || (top_bound && !same_string_set(&observed_result_ids, &trace.native_result_ids))
        || trace.qualification_source_inventory_hash
            != acceptance.verification_source_inventory_hash
        || source::memory_inventory_hash(&final_inventory)?
            != acceptance.verification_source_inventory_hash
        || source::memory_inventory_hash(&execution_inventory)?
            != trace.execution.stage_source_inventory_hash
        || (top_bound && trace.execution.generation_id != acceptance.verification_generation_id)
        || !super::io::valid_sha(&trace.execution.stage_source_inventory_hash)
        || !same_string_set(&trace.expected_source_handles, &item.expected_source_refs)
        || !same_string_set(&trace.observed_source_handles, &item.observed_source_refs)
        || !same_string_set(&trace.observed_source_handles, &item.source_refs)
        || !same_string_set(
            &trace
                .expected_source_groups
                .iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>(),
            &trace.expected_source_handles,
        )
        || trace.expected_source_groups.iter().any(|group| {
            group.is_empty()
                || group
                    .iter()
                    .any(|handle| !trace.expected_source_handles.contains(handle))
                || !group
                    .iter()
                    .any(|handle| trace.observed_source_handles.contains(handle))
        })
        || trace.observed_source_handles.iter().any(|handle| {
            trace
                .source_observations
                .iter()
                .filter(|source| &source.handle == handle)
                .count()
                != 1
        })
        || trace
            .source_observations
            .iter()
            .any(|source| !trace.observed_source_handles.contains(&source.handle))
    {
        return Err(invalid("memory_acceptance_evidence_invalid"));
    }

    for source in &trace.source_observations {
        if !super::io::valid_sha(&source.revision)
            || !super::io::valid_sha(&source.source_hash)
            || !source::valid_timestamp(&source.observed_at)
            || !matches!(
                source.currentness.as_str(),
                "current" | "historical" | "as_of"
            )
            || source.inventory_hash != trace.execution.stage_source_inventory_hash
            || !source::inventory_contains_source_observation(
                &execution_inventory,
                source,
                &trace.execution.generation_id,
                &observed_results,
                capture,
            )?
            || (top_bound
                && !source::inventory_contains_source_observation(
                    &final_inventory,
                    source,
                    &trace.execution.generation_id,
                    &observed_results,
                    capture,
                )?)
        {
            return Err(invalid("memory_acceptance_evidence_invalid"));
        }
    }

    capture_refs(capture, &trace.extractor_attempt_refs)?;
    capture_refs(capture, &trace.embedding_receipt_refs)?;
    capture_refs(
        capture,
        trace.owner_result_refs.as_deref().unwrap_or_default(),
    )?;
    capture_refs(
        capture,
        trace
            .supporting_execution_refs
            .as_deref()
            .unwrap_or_default(),
    )?;
    if (item.path == "public_app_btcc" || item.path == "native_tool")
        && trace.query.result_refs.is_empty()
    {
        return Err(invalid("memory_acceptance_evidence_invalid"));
    }
    if item.path == "public_app_btcc"
        && (trace.completion_ids.is_empty() || trace.projection_job_ids.is_empty())
        || item.path == "native_tool" && trace.native_result_ids.is_empty()
        || item.path == "owner_integration"
            && trace
                .owner_result_refs
                .as_deref()
                .unwrap_or_default()
                .is_empty()
        || item.path == "owner_integration"
            && !trace.observed_source_handles.is_empty()
            && owner_source_refs.is_empty()
        || item.path == "owner_integration"
            && item.mr_ids.iter().any(|id| id == "MR-12")
            && trace.owner_route.as_deref() != Some("production_transition")
        || item.uses_real_extractor && trace.extractor_attempt_refs.is_empty()
        || item.uses_real_embedding && trace.embedding_receipt_refs.is_empty()
    {
        return Err(invalid("memory_acceptance_evidence_invalid"));
    }
    Ok(())
}

fn embedding_execution_matches(
    embedding: &EmbeddingExecution,
    item: &AcceptanceCase,
    acceptance: &Acceptance,
    top_bound: bool,
) -> bool {
    match embedding {
        EmbeddingExecution::Executed { version } if top_bound => {
            version == &acceptance.embedding_version
        }
        EmbeddingExecution::Executed { version } => super::io::valid_sha(version),
        EmbeddingExecution::NotExecuted { reason } => {
            reason == "not_required" && !item.uses_real_embedding
        }
    }
}

fn capture_refs(capture: &mut CaptureStore, refs: &[EvidenceRef]) -> CognitionResult<()> {
    for reference in refs {
        capture.capture_ref(reference.path(), &reference.sha256)?;
    }
    Ok(())
}

pub(super) fn same_string_set(left: &[String], right: &[String]) -> bool {
    left.iter().collect::<HashSet<_>>() == right.iter().collect::<HashSet<_>>()
}
