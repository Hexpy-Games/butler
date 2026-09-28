//! One acceptance case: its trace must bind the qualified implementation and
//! inventories, and every observed source must resolve through captured
//! evidence to an inventory fact.

use std::collections::HashSet;

use crate::cognition::CognitionResult;

use super::{
    CaptureStore, invalid,
    source::{self, EvidenceInventory, ReturnedResult},
    types::{
        Acceptance, AcceptanceCase, CaseTrace, EmbeddingExecution, EvidenceRef, OwnerResult,
        QueryResult,
    },
};
use crate::cognition::CognitionCode;

/// How a case reached the memory tool.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CasePath {
    /// Through the public app turn.
    PublicAppBtcc,
    /// Through the native memory tool.
    NativeTool,
    /// Through an owner integration, observed by owner results.
    OwnerIntegration,
}

impl CasePath {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "public_app_btcc" => Some(Self::PublicAppBtcc),
            "native_tool" => Some(Self::NativeTool),
            "owner_integration" => Some(Self::OwnerIntegration),
            _ => None,
        }
    }

    /// Query-result paths are bound to the verification generation and to
    /// the final inventory; owner integrations only to their own execution.
    fn query_bound(self) -> bool {
        self != Self::OwnerIntegration
    }
}

/// Everything a case's trace points to, loaded through the capture store.
struct LoadedCase<'a> {
    item: &'a AcceptanceCase,
    path: CasePath,
    trace: CaseTrace,
    final_inventory: EvidenceInventory,
    execution_inventory: EvidenceInventory,
    query_results: Vec<QueryResult>,
    owner_source_results: Vec<OwnerResult>,
}

pub(super) fn validate_case(
    item: &AcceptanceCase,
    acceptance: &Acceptance,
    capture: &mut CaptureStore,
) -> CognitionResult<()> {
    let path = CasePath::parse(&item.path).filter(|_| {
        !item.id.is_empty()
            && item.outcome == "passed"
            && super::io::valid_sha(&item.query_hash)
            && super::io::valid_sha(&item.trace_sha256)
            && super::io::safe_ref(&item.trace_ref)
    });
    let Some(path) = path else {
        return Err(invalid(CognitionCode::MemoryAcceptanceInvalid));
    };
    let case = load(item, path, capture)?;
    if !case.trace_valid(acceptance)? {
        return Err(evidence_invalid());
    }
    case.validate_sources(capture)?;
    case.capture_supporting(capture)?;
    if !case.required_evidence_present() {
        return Err(evidence_invalid());
    }
    Ok(())
}

fn load<'a>(
    item: &'a AcceptanceCase,
    path: CasePath,
    capture: &mut CaptureStore,
) -> CognitionResult<LoadedCase<'a>> {
    let trace: CaseTrace = capture.read_json(&item.trace_ref, &item.trace_sha256)?;
    let final_inventory = capture.read_json(
        &trace.qualification_source_inventory_ref,
        &trace.qualification_source_inventory_sha256,
    )?;
    let execution_inventory = capture.read_json(
        &trace.execution.source_inventory_ref,
        &trace.execution.source_inventory_sha256,
    )?;
    let query_results = read_results(capture, &trace.query.result_refs, |result: &QueryResult| {
        &result.result_id
    })?;
    let owner_source_results = read_results(
        capture,
        trace
            .owner_source_result_refs
            .as_deref()
            .unwrap_or_default(),
        |result: &OwnerResult| &result.result_id,
    )?;
    Ok(LoadedCase {
        item,
        path,
        trace,
        final_inventory,
        execution_inventory,
        query_results,
        owner_source_results,
    })
}

/// Reads each referenced result, which must carry the id its reference names.
fn read_results<T: serde::de::DeserializeOwned>(
    capture: &mut CaptureStore,
    references: &[EvidenceRef],
    result_id: impl Fn(&T) -> &String,
) -> CognitionResult<Vec<T>> {
    references
        .iter()
        .map(|reference| {
            let expected = reference
                .result_id
                .as_deref()
                .ok_or_else(evidence_invalid)?;
            let result: T = capture.read_json(reference.path(), &reference.sha256)?;
            if result_id(&result) != expected {
                return Err(evidence_invalid());
            }
            Ok(result)
        })
        .collect()
}

impl LoadedCase<'_> {
    /// The results whose sources the case observed.
    fn observed_results(&self) -> Vec<ReturnedResult<'_>> {
        if self.path.query_bound() {
            self.query_results
                .iter()
                .map(|result| ReturnedResult {
                    result_id: &result.result_id,
                    source_handles: &result.source_handles,
                    observations: &result.observations,
                })
                .collect()
        } else {
            self.owner_source_results
                .iter()
                .map(|result| ReturnedResult {
                    result_id: &result.result_id,
                    source_handles: &result.source_handles,
                    observations: &result.observations,
                })
                .collect()
        }
    }

    fn trace_valid(&self, acceptance: &Acceptance) -> CognitionResult<bool> {
        let trace = &self.trace;
        let execution = &trace.execution;
        Ok(trace.schema == "butler.memory-recovery-case-trace.v1"
            && super::io::valid_git_commit(&execution.implementation_commit)
            && execution.implementation_commit == acceptance.implementation_commit
            && execution.tool_contract_version == acceptance.tool_contract_version
            && execution.extraction_version == acceptance.extraction_version
            && self.embedding_matches(acceptance)
            && trace.query.sha256 == self.item.query_hash
            && self.results_valid()
            && trace.qualification_source_inventory_hash
                == acceptance.verification_source_inventory_hash
            && self.final_inventory.hash()? == acceptance.verification_source_inventory_hash
            && self.execution_inventory.hash()? == execution.stage_source_inventory_hash
            && (!self.path.query_bound()
                || execution.generation_id == acceptance.verification_generation_id)
            && super::io::valid_sha(&execution.stage_source_inventory_hash)
            && self.handles_consistent())
    }

    fn embedding_matches(&self, acceptance: &Acceptance) -> bool {
        match &self.trace.execution.embedding {
            EmbeddingExecution::Executed { version } if self.path.query_bound() => {
                version == &acceptance.embedding_version
            }
            EmbeddingExecution::Executed { version } => super::io::valid_sha(version),
            EmbeddingExecution::NotExecuted { reason } => {
                reason == "not_required" && !self.item.uses_real_embedding
            }
        }
    }

    /// Query results must answer this query in this generation; owner results
    /// must come from this generation and be listed as owner results.
    fn results_valid(&self) -> bool {
        let trace = &self.trace;
        let generation = &trace.execution.generation_id;
        if self.path.query_bound() {
            let observed_ids = self
                .observed_results()
                .iter()
                .map(|result| result.result_id.to_owned())
                .collect::<Vec<_>>();
            return self.query_results.iter().all(|result| {
                result.schema == "butler.memory-query-result-evidence.v1"
                    && result.query_hash == self.item.query_hash
                    && &result.generation_id == generation
                    && Some(result.request_id.as_str()) == trace.query.request_id.as_deref()
                    && matches!(result.status.as_str(), "ok" | "partial")
            }) && same_string_set(&observed_ids, &trace.native_result_ids);
        }
        let owner_refs = trace.owner_result_refs.as_deref().unwrap_or_default();
        let source_refs = trace
            .owner_source_result_refs
            .as_deref()
            .unwrap_or_default();
        self.owner_source_results
            .iter()
            .zip(source_refs)
            .all(|(result, source_ref)| {
                result.schema == "butler.memory-owner-result-evidence.v1"
                    && &result.generation_id == generation
                    && matches!(result.status.as_str(), "ok" | "partial")
                    && owner_refs.iter().any(|reference| {
                        reference.ref_ == source_ref.ref_ && reference.sha256 == source_ref.sha256
                    })
            })
    }

    /// Expected, observed, and grouped handles must agree with the case and
    /// with exactly one source observation per observed handle.
    fn handles_consistent(&self) -> bool {
        let (trace, item) = (&self.trace, self.item);
        let grouped = trace
            .expected_source_groups
            .iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        same_string_set(&trace.expected_source_handles, &item.expected_source_refs)
            && same_string_set(&trace.observed_source_handles, &item.observed_source_refs)
            && same_string_set(&trace.observed_source_handles, &item.source_refs)
            && same_string_set(&grouped, &trace.expected_source_handles)
            && trace.expected_source_groups.iter().all(|group| {
                !group.is_empty()
                    && group
                        .iter()
                        .all(|handle| trace.expected_source_handles.contains(handle))
                    && group
                        .iter()
                        .any(|handle| trace.observed_source_handles.contains(handle))
            })
            && trace.observed_source_handles.iter().all(|handle| {
                trace
                    .source_observations
                    .iter()
                    .filter(|source| &source.handle == handle)
                    .count()
                    == 1
            })
            && trace
                .source_observations
                .iter()
                .all(|source| trace.observed_source_handles.contains(&source.handle))
    }

    /// Every observation must resolve to a fact of the execution inventory,
    /// and of the final inventory for query-bound paths.
    fn validate_sources(&self, capture: &mut CaptureStore) -> CognitionResult<()> {
        let trace = &self.trace;
        let generation = &trace.execution.generation_id;
        let observed = self.observed_results();
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
                    &self.execution_inventory,
                    source,
                    generation,
                    &observed,
                    capture,
                )?
                || (self.path.query_bound()
                    && !source::inventory_contains_source_observation(
                        &self.final_inventory,
                        source,
                        generation,
                        &observed,
                        capture,
                    )?)
            {
                return Err(evidence_invalid());
            }
        }
        Ok(())
    }

    fn capture_supporting(&self, capture: &mut CaptureStore) -> CognitionResult<()> {
        let trace = &self.trace;
        for refs in [
            trace.extractor_attempt_refs.as_slice(),
            &trace.embedding_receipt_refs,
            trace.owner_result_refs.as_deref().unwrap_or_default(),
            trace
                .supporting_execution_refs
                .as_deref()
                .unwrap_or_default(),
        ] {
            for reference in refs {
                capture.capture_ref(reference.path(), &reference.sha256)?;
            }
        }
        Ok(())
    }

    /// Each path must carry the evidence that shows it really ran.
    fn required_evidence_present(&self) -> bool {
        let (trace, item) = (&self.trace, self.item);
        let owner_refs = trace.owner_result_refs.as_deref().unwrap_or_default();
        let owner_source_refs = trace
            .owner_source_result_refs
            .as_deref()
            .unwrap_or_default();
        let path_evidence = match self.path {
            CasePath::PublicAppBtcc => {
                !trace.query.result_refs.is_empty()
                    && !trace.completion_ids.is_empty()
                    && !trace.projection_job_ids.is_empty()
            }
            CasePath::NativeTool => {
                !trace.query.result_refs.is_empty() && !trace.native_result_ids.is_empty()
            }
            CasePath::OwnerIntegration => {
                !owner_refs.is_empty()
                    && (trace.observed_source_handles.is_empty() || !owner_source_refs.is_empty())
                    && (!item.mr_ids.iter().any(|id| id == "MR-12")
                        || trace.owner_route.as_deref() == Some("production_transition"))
            }
        };
        path_evidence
            && (!item.uses_real_extractor || !trace.extractor_attempt_refs.is_empty())
            && (!item.uses_real_embedding || !trace.embedding_receipt_refs.is_empty())
    }
}

fn evidence_invalid() -> crate::cognition::CognitionError {
    invalid(CognitionCode::MemoryAcceptanceEvidenceInvalid)
}

pub(super) fn same_string_set(left: &[String], right: &[String]) -> bool {
    left.iter().collect::<HashSet<_>>() == right.iter().collect::<HashSet<_>>()
}
