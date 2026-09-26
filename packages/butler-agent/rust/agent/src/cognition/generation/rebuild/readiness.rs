//! Source snapshot, graph, Lance, and retained-cache witness for a building generation.

pub(in crate::cognition::generation) mod cache;

use std::{collections::HashSet, fs, path::Path, sync::Arc};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::{
    initialize::durable,
    qualification_witness::{CandidateWitness, LiveWitness},
};
use super::{build_inventory, inventory};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
        MemoryGenerationTarget, assert_mutation_authority, ensure_data_authority,
        generation::cache::physical_entries,
        generation_vectors::invalid_persisted_rebuild_vectors,
        graph::{GraphRepository, StageReadiness},
        resolve_generation,
    },
    conversation::ConversationSourceReader,
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

struct GraphFacts {
    registered: usize,
    expected: usize,
    unexpected: usize,
    semantic_invalid: usize,
    graph_invalid: usize,
    canonical_invalid: usize,
    stage: StageReadiness,
    vector_receipt_invalid: usize,
    historical: HashSet<String>,
    cache_static_invalid: usize,
    cache_actual_invalid: usize,
    valid_cache_ids: Vec<String>,
    cache_outcomes: Vec<(String, bool)>,
    cache_sha256: Option<String>,
}

pub(crate) async fn record(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let MemoryGenerationTarget::Rebuild { .. } = target else {
        return Err(error("memory_rebuild_invalid_request"));
    };
    let handle = resolve_generation(data_root, environment, target)?;
    let lock = environment.consolidation_lock(data_root);
    let active = environment
        .memory_root(data_root)
        .join("active-generation.json");
    let manifest_path = handle.root.join("manifest.json");
    let cache_path = handle.root.join("hot/cache.md");
    let snapshot_path = handle.source_root.join("memory-source-inventory.json");
    let canonical = handle
        .canonical_snapshot_path
        .as_deref()
        .ok_or_else(|| error("memory_snapshot_changed"))?;
    ensure_data_authority(
        data_root,
        &[
            &lock,
            &active,
            &manifest_path,
            &handle.graph_path,
            &cache_path,
            &snapshot_path,
            canonical,
            &handle.root.join("butler.lance"),
            &handle.root.join("butler.lance/butler_memory.lance"),
        ],
    )?;
    let live = LiveWitness::open(data_root)?;
    let candidate = CandidateWitness::open(data_root, &handle).await?;
    let readiness = compute(data_root, environment, target, cancellation).await?;
    candidate.assert_current(&handle).await?;
    live.assert_current()?;
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some("rebuild_readiness".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let result = async {
        lease
            .assert_for_path(&lock)
            .map_err(|_| error("memory_write_busy"))?;
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        let current = resolve_generation(data_root, environment, target)?;
        assert_mutation_authority(data_root, environment, target, &current)?;
        if current
            .embedding
            .as_ref()
            .map(super::super::types::GenerationEmbedding::version)
            != handle
                .embedding
                .as_ref()
                .map(super::super::types::GenerationEmbedding::version)
        {
            return Err(error("memory_embedding_version_mismatch"));
        }
        candidate.assert_current(&current).await?;
        live.assert_current()?;
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        let mut manifest: Value = serde_json::from_slice(
            &fs::read(&manifest_path).map_err(|_| error("memory_generation_unavailable"))?,
        )
        .map_err(|_| error("memory_generation_unavailable"))?;
        if manifest["source_inventory_hash"] != readiness["inventory_hash"]
            || manifest["state"] != "building"
        {
            return Err(error("memory_generation_changed"));
        }
        let changed = manifest["readiness"]["sha256"] != readiness["sha256"]
            || manifest["acceptance_binding"]["target_evidence_sha256"]
                != readiness["evidence_sha256"];
        manifest["readiness"] = readiness.clone();
        manifest["registered_source_count"] = readiness["registered"].clone();
        manifest["unaccounted_source_count"] = readiness["unaccounted"].clone();
        if changed {
            manifest["required_acceptance_passed"] = Value::Bool(false);
        }
        durable::write_json(&manifest_path, &manifest)?;
        Ok(readiness)
    }
    .await;
    let released = lease
        .release(result.is_ok())
        .map_err(|_| error("memory_write_busy"));
    result.and_then(|value| {
        released?;
        Ok(value)
    })
}

/// Read-only calculation shared with validation. The caller owns its candidate
/// witness and write gate when it needs a stable commit boundary.
pub(crate) async fn compute(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let MemoryGenerationTarget::Rebuild { .. } = target else {
        return Err(error("memory_rebuild_invalid_request"));
    };
    let current = resolve_generation(data_root, environment, target)?;
    let manifest_path = current.root.join("manifest.json");
    let snapshot_path = current.source_root.join("memory-source-inventory.json");
    let canonical = current
        .canonical_snapshot_path
        .as_deref()
        .ok_or_else(|| error("memory_snapshot_changed"))?;
    ensure_data_authority(
        data_root,
        &[
            &manifest_path,
            &snapshot_path,
            &current.graph_path,
            canonical,
            &current.root.join("hot/cache.md"),
            &current.root.join("butler.lance"),
            &current.root.join("butler.lance/butler_memory.lance"),
        ],
    )?;
    let data_for_graph = data_root.to_owned();
    let current_for_graph = current.clone();
    let cancel = cancellation.clone();
    let facts = tokio::task::spawn_blocking(move || {
        graph_facts(&data_for_graph, &current_for_graph, &cancel)
    })
    .await
    .map_err(|_| error("memory_readiness_unavailable"))??;
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let vector_actual_invalid = invalid_persisted_rebuild_vectors(
        data_root,
        &current,
        &facts.stage.vector_rows,
        &facts.historical,
    )
    .await?;
    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).map_err(|_| error("memory_generation_unavailable"))?,
    )
    .map_err(|_| error("memory_generation_unavailable"))?;
    let stored: Value = serde_json::from_slice(
        &fs::read(&snapshot_path).map_err(|_| error("memory_snapshot_changed"))?,
    )
    .map_err(|_| error("memory_snapshot_changed"))?;
    let inventory_hash = manifest["source_inventory_hash"]
        .as_str()
        .ok_or_else(|| error("memory_inventory_changed"))?;
    let missing = facts.expected.saturating_sub(facts.registered);
    let unaccounted = missing
        + facts.unexpected
        + facts.semantic_invalid
        + facts.vector_receipt_invalid
        + facts.cache_static_invalid
        + facts.graph_invalid
        + facts.canonical_invalid
        + vector_actual_invalid
        + facts.cache_actual_invalid;
    let evidence = json!({
        "schema":"butler.native-memory-readiness-evidence.v1","inventory_hash":inventory_hash,
        "as_of":stored["as_of"],"embedding_version":manifest["embedding"]["version"],
        "extraction_version":manifest["extraction_version"],"unicode_version":manifest["unicode_version"],"icu_version":manifest["icu_version"],
        "registered":facts.registered,"expected":facts.expected,"unexpected":facts.unexpected,
        "semantic_invalid":facts.semantic_invalid,"vector_receipt_invalid":facts.vector_receipt_invalid,
        "cache_static_invalid":facts.cache_static_invalid,"graph_invalid":facts.graph_invalid,
        "canonical_invalid":facts.canonical_invalid,"vector_actual_invalid":vector_actual_invalid,
        "cache_actual_invalid":facts.cache_actual_invalid,"cache_sha256":facts.cache_sha256,
        "cache_retained_ids":facts.valid_cache_ids,"cache_outcomes":facts.cache_outcomes,
        "vector_rows":facts.stage.vector_rows,"cache_rows":facts.stage.cache_rows,
    });
    let evidence_sha = hash(&evidence)?;
    let semantic = &facts.stage.semantic;
    let vectors = &facts.stage.vectors;
    let cache = &facts.stage.cache;
    let ready = unaccounted == 0
        && semantic.pending == 0
        && semantic.failed == 0
        && vectors.pending == 0
        && vectors.failed == 0
        && vectors.not_configured == 0
        && cache.pending == 0
        && cache.failed == 0
        && cache.not_configured == 0;
    let mut readiness = json!({"schema":"butler.memory-generation-readiness.v1","inventory_hash":inventory_hash,
        "registered":facts.registered,"unaccounted":unaccounted,
        "semantic":{"complete":semantic.complete,"unsupported":semantic.unsupported.unwrap_or(0),"pending":semantic.pending,"failed":semantic.failed},
        "vectors":{"complete":vectors.complete,"pending":vectors.pending,"failed":vectors.failed,"not_configured":vectors.not_configured},
        "cache":{"complete":cache.complete,"pending":cache.pending,"failed":cache.failed,"not_configured":cache.not_configured},
        "evidence_sha256":evidence_sha,"ready":ready});
    readiness["sha256"] = Value::String(hash(&readiness)?);
    Ok(readiness)
}

fn graph_facts(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    cancellation: &CancellationToken,
) -> CognitionResult<GraphFacts> {
    let stored = verified_live_inventory(data_root, handle, cancellation)?;
    let as_of = stored["as_of"]
        .as_str()
        .ok_or_else(|| error("memory_inventory_changed"))?;
    let canonical = ConversationSourceReader::open(
        handle
            .canonical_snapshot_path
            .as_deref()
            .ok_or_else(|| error("memory_snapshot_changed"))?,
    )
    .map_err(|_| error("memory_snapshot_changed"))?;
    let graph = GraphRepository::open_readonly(&handle.graph_path)?;
    let source = graph.rebuild_source_readiness(
        &handle.generation_id,
        &stored,
        &canonical,
        &handle.source_root,
    )?;
    let stage = graph.rebuild_stage_readiness(&handle.generation_id)?;
    let cache_file = handle.root.join("hot/cache.md");
    let cache_text = match fs::read_to_string(&cache_file) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(error("memory_readiness_unavailable")),
    };
    let physical = cache_text
        .as_deref()
        .map(physical_entries)
        .unwrap_or_default();
    let valid_cache = graph.valid_rebuild_cache_entries(
        &handle.generation_id,
        &physical,
        &handle.source_root,
        &canonical,
        as_of,
    )?;
    let outcomes = graph.rebuild_cache_outcomes(&handle.generation_id)?;
    let cache_evidence = cache::evaluate(
        &stage.cache_rows,
        &outcomes,
        &valid_cache,
        &handle.generation_id,
    );
    let mut cache_outcomes = outcomes.into_iter().collect::<Vec<_>>();
    cache_outcomes.sort_by(|left, right| left.0.cmp(&right.0));
    let mut valid_cache_ids = valid_cache.into_iter().collect::<Vec<_>>();
    valid_cache_ids.sort();
    let cache_sha256 = cache_text
        .as_deref()
        .map(|value| format!("{:x}", Sha256::digest(value.as_bytes())));
    let vector_receipt_invalid = stage
        .vector_rows
        .iter()
        .filter(|row| {
            if row.source_membership_invalid {
                return true;
            }
            let Some(raw) = row.receipt_json.as_deref() else {
                return true;
            };
            let Ok(receipt) = serde_json::from_str::<Value>(raw) else {
                return true;
            };
            let Some(version) = handle
                .embedding
                .as_ref()
                .map(super::super::types::GenerationEmbedding::version)
            else {
                return true;
            };
            let Some(refs) = row
                .source_ids_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
            else {
                return true;
            };
            receipt["generation"] != handle.generation_id
                || receipt["embedding_version"] != version
                || refs.is_empty()
                || refs.iter().any(|id| !source.historical.contains(id))
        })
        .count();
    graph.close()?;
    canonical
        .close()
        .map_err(|_| error("memory_snapshot_changed"))?;
    Ok(GraphFacts {
        registered: source.registered,
        expected: source.expected_count,
        unexpected: source.unexpected,
        semantic_invalid: source.semantic_invalid,
        graph_invalid: source.graph_invalid,
        canonical_invalid: source.canonical_invalid,
        stage,
        vector_receipt_invalid,
        historical: source.historical,
        cache_static_invalid: cache_evidence.static_invalid,
        cache_actual_invalid: cache_evidence.actual_invalid,
        valid_cache_ids,
        cache_outcomes,
        cache_sha256,
    })
}

/// Exact live source hash/count check shared by readiness and qualification.
/// It runs before either command enters the short manifest commit gate.
pub(in crate::cognition::generation) fn assert_live_inventory_matches_candidate(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    cancellation: &CancellationToken,
) -> CognitionResult<()> {
    verified_live_inventory(data_root, handle, cancellation).map(|_| ())
}

fn verified_live_inventory(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    cancellation: &CancellationToken,
) -> CognitionResult<Value> {
    let inventory = build_inventory::read(data_root, handle, cancellation)?;
    let stored: Value = serde_json::from_slice(
        &fs::read(handle.source_root.join("memory-source-inventory.json"))
            .map_err(|_| error("memory_snapshot_changed"))?,
    )
    .map_err(|_| error("memory_snapshot_changed"))?;
    let as_of = stored["as_of"]
        .as_str()
        .ok_or_else(|| error("memory_inventory_changed"))?;
    let live = inventory::read(
        data_root,
        &data_root.join("runtime/conversation-store.sqlite"),
        as_of,
        cancellation,
    )?;
    let manifest: Value = serde_json::from_slice(
        &fs::read(handle.root.join("manifest.json"))
            .map_err(|_| error("memory_generation_unavailable"))?,
    )
    .map_err(|_| error("memory_generation_unavailable"))?;
    if live.hash != manifest["source_inventory_hash"]
        || live.source_count != inventory.expected_source_count
    {
        return Err(error("memory_inventory_changed"));
    }
    Ok(stored)
}

fn hash(value: &Value) -> CognitionResult<String> {
    let serialized =
        crate::json::stringify(value).map_err(|_| error("memory_readiness_unavailable"))?;
    Ok(format!("{:x}", Sha256::digest(serialized.as_bytes())))
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
