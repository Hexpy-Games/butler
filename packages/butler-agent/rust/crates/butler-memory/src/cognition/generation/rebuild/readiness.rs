//! Readiness of a building generation: every expected source registered and
//! every projection stage settled, witnessed against the source snapshot,
//! graph, Lance table, and retained hot cache.
//!
//! [`compute`] is the read-only calculation; [`record`] recomputes it and
//! stores it in the manifest under the write gate.

pub(in crate::cognition::generation) mod cache;

use crate::cognition::CognitionCode;
use std::{collections::HashSet, fs, path::Path, sync::Arc};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::{
    initialize::durable,
    manifest::{
        GenerationManifest, GenerationReadiness, GenerationState, SemanticCounts, StageCounts,
    },
    qualification_witness::{CandidateWitness, LiveWitness},
};
use super::{build_inventory, inventory};
use crate::cognition::generation::cache::physical_entries;
use crate::cognition::generation_vectors::invalid_persisted_rebuild_vectors;
use crate::cognition::graph::{
    CacheReadinessRow, GraphRepository, StageReadiness, VectorReadinessRow,
};
use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
    MemoryGenerationTarget, assert_mutation_authority, ensure_data_authority, resolve_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};
use butler_turn::conversation::ConversationSourceReader;

/// Source, graph, and cache facts gathered on the blocking pool.
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

/// Everything readiness depends on; its hash binds qualification to it.
#[derive(Serialize)]
struct ReadinessEvidence<'a> {
    schema: &'static str,
    inventory_hash: &'a str,
    as_of: &'a str,
    embedding_version: Option<&'a str>,
    extraction_version: Option<&'a str>,
    unicode_version: Option<&'a str>,
    icu_version: Option<&'a str>,
    registered: usize,
    expected: usize,
    unexpected: usize,
    semantic_invalid: usize,
    vector_receipt_invalid: usize,
    cache_static_invalid: usize,
    graph_invalid: usize,
    canonical_invalid: usize,
    vector_actual_invalid: usize,
    cache_actual_invalid: usize,
    cache_sha256: Option<&'a str>,
    cache_retained_ids: &'a [String],
    cache_outcomes: &'a [(String, bool)],
    vector_rows: &'a [VectorReadinessRow],
    cache_rows: &'a [CacheReadinessRow],
}

/// Recomputes readiness and stores it in the candidate manifest. A changed
/// readiness or evidence hash clears `required_acceptance_passed`.
pub async fn record(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<GenerationReadiness> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let MemoryGenerationTarget::Rebuild { .. } = target else {
        return Err(error(CognitionCode::MemoryRebuildInvalidRequest));
    };
    let handle = resolve_generation(data_root, environment, target)?;
    let lock = environment.consolidation_lock(data_root);
    ensure_record_authority(data_root, environment, &handle, &lock)?;
    let live = LiveWitness::open(data_root)?;
    let candidate = CandidateWitness::open(data_root, &handle).await?;
    let readiness = compute(data_root, environment, target, cancellation).await?;
    candidate.assert_current(&handle).await?;
    live.assert_current()?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
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
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    let witnesses = (&live, &candidate, &handle);
    let result = async {
        lease
            .assert_for_path(&lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        commit_readiness(
            data_root,
            environment,
            target,
            witnesses,
            &readiness,
            cancellation,
        )
        .await
    }
    .await;
    let released = lease
        .release(result.is_ok())
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source));
    result.and_then(|()| {
        released?;
        Ok(readiness)
    })
}

fn ensure_record_authority(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    handle: &MemoryGenerationHandle,
    lock: &Path,
) -> CognitionResult<()> {
    let canonical = handle
        .canonical_snapshot_path
        .as_deref()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    ensure_data_authority(
        data_root,
        &[
            lock,
            &environment
                .memory_root(data_root)
                .join("active-generation.json"),
            &handle.root.join("manifest.json"),
            &handle.graph_path,
            &handle.root.join("hot/cache.md"),
            &handle.source_root.join("memory-source-inventory.json"),
            canonical,
            &handle.root.join("butler.lance"),
            &handle.root.join("butler.lance/butler_memory.lance"),
        ],
    )
}

/// Under the write gate: confirm nothing changed since `readiness` was
/// computed, then store it.
async fn commit_readiness(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    target: &MemoryGenerationTarget,
    (live, candidate, handle): (&LiveWitness, &CandidateWitness, &MemoryGenerationHandle),
    readiness: &GenerationReadiness,
    cancellation: &CancellationToken,
) -> CognitionResult<()> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let current = resolve_generation(data_root, environment, target)?;
    assert_mutation_authority(data_root, environment, target, &current)?;
    let version = |handle: &MemoryGenerationHandle| {
        handle
            .embedding
            .as_ref()
            .map(|embedding| embedding.version().to_owned())
    };
    if version(&current) != version(handle) {
        return Err(error(CognitionCode::MemoryEmbeddingVersionMismatch));
    }
    candidate.assert_current(&current).await?;
    live.assert_current()?;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let manifest_path = handle.root.join("manifest.json");
    let mut manifest =
        GenerationManifest::read(&manifest_path, CognitionCode::MemoryGenerationUnavailable)?;
    if manifest.source_inventory_hash.as_deref() != Some(readiness.inventory_hash.as_str())
        || manifest.state != Some(GenerationState::Building)
    {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    let changed = manifest
        .readiness
        .as_ref()
        .and_then(|stored| stored.sha256.as_deref())
        != readiness.sha256.as_deref()
        || manifest
            .acceptance_binding
            .as_ref()
            .map(|binding| binding.target_evidence_sha256.as_str())
            != Some(readiness.evidence_sha256.as_str());
    manifest.record_readiness(readiness);
    if changed {
        manifest.required_acceptance_passed = Some(false);
    }
    durable::write_json(&manifest_path, &manifest)
}

/// Read-only calculation shared with validation. The caller owns its candidate
/// witness and write gate when it needs a stable commit boundary.
pub async fn compute(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<GenerationReadiness> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let MemoryGenerationTarget::Rebuild { .. } = target else {
        return Err(error(CognitionCode::MemoryRebuildInvalidRequest));
    };
    let current = resolve_generation(data_root, environment, target)?;
    let manifest_path = current.root.join("manifest.json");
    let snapshot_path = current.source_root.join("memory-source-inventory.json");
    let canonical = current
        .canonical_snapshot_path
        .as_deref()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
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
    let (data_for_graph, current_for_graph, cancel) =
        (data_root.to_owned(), current.clone(), cancellation.clone());
    let facts = tokio::task::spawn_blocking(move || {
        graph_facts(&data_for_graph, &current_for_graph, &cancel)
    })
    .await
    .map_err(|source| error(CognitionCode::MemoryReadinessUnavailable).with_source(source))??;
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let vector_actual_invalid = invalid_persisted_rebuild_vectors(
        data_root,
        &current,
        &facts.stage.vector_rows,
        &facts.historical,
    )
    .await?;
    let manifest =
        GenerationManifest::read(&manifest_path, CognitionCode::MemoryGenerationUnavailable)?;
    let as_of = inventory::MemorySourceInventory::read(&snapshot_path)?.as_of;
    let inventory_hash = manifest
        .source_inventory_hash
        .as_deref()
        .ok_or_else(|| error(CognitionCode::MemoryInventoryChanged))?;
    let evidence = evidence(
        &facts,
        &manifest,
        inventory_hash,
        &as_of,
        vector_actual_invalid,
    );
    let unaccounted = unaccounted(&facts, vector_actual_invalid);
    let mut readiness = GenerationReadiness::new(
        inventory_hash.to_owned(),
        facts.registered,
        unaccounted,
        stored_counts(&facts.stage),
        hash(&evidence)?,
    );
    readiness.sha256 = Some(hash(&readiness)?);
    Ok(readiness)
}

fn evidence<'a>(
    facts: &'a GraphFacts,
    manifest: &'a GenerationManifest,
    inventory_hash: &'a str,
    as_of: &'a str,
    vector_actual_invalid: usize,
) -> ReadinessEvidence<'a> {
    ReadinessEvidence {
        schema: "butler.native-memory-readiness-evidence.v1",
        inventory_hash,
        as_of,
        embedding_version: manifest.embedding_version(),
        extraction_version: manifest.extraction_version.as_deref(),
        unicode_version: manifest.unicode_version.as_deref(),
        icu_version: manifest.icu_version.as_deref(),
        registered: facts.registered,
        expected: facts.expected,
        unexpected: facts.unexpected,
        semantic_invalid: facts.semantic_invalid,
        vector_receipt_invalid: facts.vector_receipt_invalid,
        cache_static_invalid: facts.cache_static_invalid,
        graph_invalid: facts.graph_invalid,
        canonical_invalid: facts.canonical_invalid,
        vector_actual_invalid,
        cache_actual_invalid: facts.cache_actual_invalid,
        cache_sha256: facts.cache_sha256.as_deref(),
        cache_retained_ids: &facts.valid_cache_ids,
        cache_outcomes: &facts.cache_outcomes,
        vector_rows: &facts.stage.vector_rows,
        cache_rows: &facts.stage.cache_rows,
    }
}

/// Sources missing from, unexpected in, or invalid in any stage.
fn unaccounted(facts: &GraphFacts, vector_actual_invalid: usize) -> usize {
    facts.expected.saturating_sub(facts.registered)
        + facts.unexpected
        + facts.semantic_invalid
        + facts.vector_receipt_invalid
        + facts.cache_static_invalid
        + facts.graph_invalid
        + facts.canonical_invalid
        + vector_actual_invalid
        + facts.cache_actual_invalid
}

/// Semantic, vector, and cache counts in their stored shapes.
fn stored_counts(stage: &StageReadiness) -> (SemanticCounts, StageCounts, StageCounts) {
    let semantic = SemanticCounts {
        complete: stage.semantic.complete,
        unsupported: stage.semantic.unsupported.unwrap_or(0),
        pending: stage.semantic.pending,
        failed: stage.semantic.failed,
    };
    let [vectors, cache] = [&stage.vectors, &stage.cache].map(|counts| StageCounts {
        complete: counts.complete,
        pending: counts.pending,
        failed: counts.failed,
        not_configured: counts.not_configured,
    });
    (semantic, vectors, cache)
}

fn graph_facts(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    cancellation: &CancellationToken,
) -> CognitionResult<GraphFacts> {
    let stored = verified_live_inventory(data_root, handle, cancellation)?;
    let as_of = stored.as_of.clone();
    let canonical = ConversationSourceReader::open(
        handle
            .canonical_snapshot_path
            .as_deref()
            .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?,
    )
    .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
    let graph = GraphRepository::open_readonly(&handle.graph_path)?;
    let source = graph.rebuild_source_readiness(
        &handle.generation_id,
        &stored,
        &canonical,
        &handle.source_root,
    )?;
    let stage = graph.rebuild_stage_readiness(&handle.generation_id)?;
    let cache = cache_facts(&graph, handle, &stage, &canonical, &as_of)?;
    let vector_receipt_invalid = stage
        .vector_rows
        .iter()
        .filter(|row| vector_receipt_invalid(row, handle, &source.historical))
        .count();
    graph.close()?;
    canonical
        .close()
        .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
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
        cache_static_invalid: cache.static_invalid,
        cache_actual_invalid: cache.actual_invalid,
        valid_cache_ids: cache.valid_ids,
        cache_outcomes: cache.outcomes,
        cache_sha256: cache.sha256,
    })
}

/// Retained hot-cache evidence of a candidate.
struct CacheFacts {
    static_invalid: usize,
    actual_invalid: usize,
    valid_ids: Vec<String>,
    outcomes: Vec<(String, bool)>,
    sha256: Option<String>,
}

fn cache_facts(
    graph: &GraphRepository,
    handle: &MemoryGenerationHandle,
    stage: &StageReadiness,
    canonical: &ConversationSourceReader,
    as_of: &str,
) -> CognitionResult<CacheFacts> {
    let cache_text = match fs::read_to_string(handle.root.join("hot/cache.md")) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(error(CognitionCode::MemoryReadinessUnavailable)),
    };
    let physical = cache_text
        .as_deref()
        .map(physical_entries)
        .unwrap_or_default();
    let valid_cache = graph.valid_rebuild_cache_entries(
        &handle.generation_id,
        &physical,
        &handle.source_root,
        canonical,
        as_of,
    )?;
    let outcomes = graph.rebuild_cache_outcomes(&handle.generation_id)?;
    let evaluated = cache::evaluate(
        &stage.cache_rows,
        &outcomes,
        &valid_cache,
        &handle.generation_id,
    );
    let mut sorted_outcomes = outcomes.into_iter().collect::<Vec<_>>();
    sorted_outcomes.sort_by(|left, right| left.0.cmp(&right.0));
    let mut valid_ids = valid_cache.into_iter().collect::<Vec<_>>();
    valid_ids.sort();
    Ok(CacheFacts {
        static_invalid: evaluated.static_invalid,
        actual_invalid: evaluated.actual_invalid,
        valid_ids,
        outcomes: sorted_outcomes,
        sha256: cache_text.map(|value| format!("{:x}", Sha256::digest(value.as_bytes()))),
    })
}

/// A stored vector receipt must name this generation and embedding version
/// and reference only sources historically registered in the graph.
fn vector_receipt_invalid(
    row: &VectorReadinessRow,
    handle: &MemoryGenerationHandle,
    historical: &HashSet<String>,
) -> bool {
    #[derive(serde::Deserialize)]
    struct Receipt {
        #[serde(default, deserialize_with = "crate::lenient::option")]
        generation: Option<String>,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        embedding_version: Option<String>,
    }
    if row.source_membership_invalid {
        return true;
    }
    let Some(receipt) = row
        .receipt_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Receipt>(raw).ok())
    else {
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
    receipt.generation.as_deref() != Some(handle.generation_id.as_str())
        || receipt.embedding_version.as_deref() != Some(version)
        || refs.is_empty()
        || refs.iter().any(|id| !historical.contains(id))
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
) -> CognitionResult<inventory::MemorySourceInventory> {
    let inventory = build_inventory::read(data_root, handle, cancellation)?;
    let stored = inventory::MemorySourceInventory::read(
        &handle.source_root.join("memory-source-inventory.json"),
    )?;
    let as_of = stored.as_of.as_str();
    let live = inventory::read(
        data_root,
        &data_root.join("runtime/conversation-store.sqlite"),
        as_of,
        cancellation,
    )?;
    let manifest = GenerationManifest::read(
        &handle.root.join("manifest.json"),
        CognitionCode::MemoryGenerationUnavailable,
    )?;
    if manifest.source_inventory_hash.as_deref() != Some(live.hash.as_str())
        || live.source_count != inventory.expected_source_count
    {
        return Err(error(CognitionCode::MemoryInventoryChanged));
    }
    Ok(stored)
}

fn hash(value: &impl Serialize) -> CognitionResult<String> {
    let unavailable = |source| error(CognitionCode::MemoryReadinessUnavailable).with_source(source);
    let value = serde_json::to_value(value).map_err(unavailable)?;
    let serialized = butler_core::json::stringify(&value)
        .map_err(|source| error(CognitionCode::MemoryReadinessUnavailable).with_source(source))?;
    Ok(format!("{:x}", Sha256::digest(serialized.as_bytes())))
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
