//! The graph, hot-cache and vector facts a readiness commit is checked against.

use super::*;

pub(super) fn graph_facts(
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
pub(super) struct CacheFacts {
    static_invalid: usize,
    actual_invalid: usize,
    valid_ids: Vec<String>,
    outcomes: Vec<(String, bool)>,
    sha256: Option<String>,
}

pub(super) fn cache_facts(
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
pub(super) fn vector_receipt_invalid(
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
        .map(super::super::super::types::GenerationEmbedding::version)
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
