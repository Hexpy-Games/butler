//! One source-current checked vector quantum, sharing the Host embedding owner.

use std::time::{SystemTime, UNIX_EPOCH};

use super::{Input, canonical_path, resolve_input_generation};
use crate::{
    cognition::{
        CognitionEmbeddingPort, CognitionError, CognitionResult, ConversationSourceNotice,
        EmbeddingMode, EmbeddingRequest, EmbeddingRequestClass, MemoryGenerationHandle,
        MemoryGenerationTarget, assert_conversation_source_current, assert_mutation_authority,
        bind_native_embedding_identity, ensure_data_authority,
        generation_vectors::{GenerationVectorRow, NativeGenerationVectorStore, persisted_receipt},
        graph::{ClaimedVectorUnit, GraphRepository},
        resolve_generation,
        sources::read_typed_record,
    },
    conversation::ConversationSourceReader,
    coordination::{CognitionWaitClass, CognitionWriteAcquire},
};
use chrono::{DateTime, SecondsFormat, Utc};

pub(super) async fn process(
    input: &Input,
    embedding: &dyn CognitionEmbeddingPort,
) -> CognitionResult<bool> {
    if input.shutdown.is_cancelled() {
        return Ok(false);
    }
    let generation = resolve_input_generation(input)?;
    if generation
        .embedding
        .as_ref()
        .is_some_and(|value| value.native_identity().is_none())
    {
        return Ok(false);
    }
    let now = (input.clock)();
    let units = {
        let _lease = acquire(input, "memory-vector-claim").await?;
        assert_generation_current(input, &generation, true)?;
        let mut graph = GraphRepository::open(&generation.graph_path)?;
        let units = graph.claim_vector_quantum(&now)?;
        graph.close()?;
        if !units.is_empty() {
            assert_current(input, &generation, &units, true)?;
        }
        units
    };
    if units.is_empty() {
        return Ok(false);
    }
    let result = run_claimed(input, embedding, &generation, &units).await;
    if let Err(failure) = &result {
        // A cancelled admission leaves the durable running claim for recovery.
        // Failure bookkeeping must never cross the generation/source write gate.
        if let Ok(_lease) = acquire(input, "memory-vector-fail").await
            && assert_current(input, &generation, &units, true).is_ok()
        {
            let mut graph = GraphRepository::open(&generation.graph_path)?;
            graph.fail_vector_quantum(&units, failure.code, &(input.clock)())?;
            graph.close()?;
        }
    }
    result.map(|()| true)
}

async fn run_claimed(
    input: &Input,
    embedding: &dyn CognitionEmbeddingPort,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
) -> CognitionResult<()> {
    let target = input
        .target
        .clone()
        .unwrap_or(MemoryGenerationTarget::Active {
            expected_generation: generation.generation_id.clone(),
        });
    let store =
        NativeGenerationVectorStore::new(input.data_root.clone(), input.environment.clone());
    if let Some(identity) = generation
        .embedding
        .as_ref()
        .and_then(|value| value.native_identity())
    {
        let rows = units
            .iter()
            .map(|unit| row(unit, generation, identity.version.as_str(), Vec::new()))
            .collect::<CognitionResult<Vec<_>>>()?;
        if let Some(receipt) = persisted_receipt(&input.data_root, generation, &rows).await? {
            let _lease = acquire(input, "memory-vector-receipt").await?;
            assert_current(input, generation, units, true)?;
            let mut graph = GraphRepository::open(&generation.graph_path)?;
            graph.complete_vector_quantum(units, &receipt, &(input.clock)())?;
            graph.close()?;
            return Ok(());
        }
    }
    {
        let _lease = acquire(input, "memory-vector-invocation").await?;
        assert_current(input, generation, units, true)?;
        let mut graph = GraphRepository::open(&generation.graph_path)?;
        graph.mark_vector_invoked(units)?;
        graph.close()?;
    }
    let deadline = epoch_ms().saturating_add(30_000);
    let embedded = embedding
        .embed(
            EmbeddingRequest {
                texts: units
                    .iter()
                    .map(|unit| unit.projection_text.clone())
                    .collect(),
                mode: EmbeddingMode::CheckedCls,
                resplit: true,
                max_embeddings: Some(4),
                request_class: EmbeddingRequestClass::Background,
                deadline_at_epoch_ms: Some(deadline),
            },
            input.shutdown.child_token(),
        )
        .await?;
    if embedded.embeddings.len() != units.len()
        || embedded.embedded_texts.as_deref().is_none_or(|texts| {
            texts.len() != units.len()
                || texts
                    .iter()
                    .zip(units)
                    .any(|(text, unit)| text != &unit.projection_text)
        })
        || embedded.omitted_count.unwrap_or(0) > 0
    {
        return Err(error("memory_vector_receipt_mismatch"));
    }
    let observed = embedded.metadata;
    if observed.pooling != "cls" {
        return Err(error("memory_embedding_version_mismatch"));
    }
    let rows = units
        .iter()
        .zip(embedded.embeddings)
        .map(|(unit, vector)| row(unit, generation, &observed.version, vector))
        .collect::<CognitionResult<Vec<_>>>()?;
    let lease = acquire(input, "memory-vector-write").await?;
    assert_current(input, generation, units, true)?;
    {
        let mut graph = GraphRepository::open(&generation.graph_path)?;
        graph.mark_vector_received(units)?;
        graph.close()?;
    }
    let current = resolve_generation(&input.data_root, &input.environment, &target)?;
    let pinned = match current.embedding.as_ref() {
        None => bind_native_embedding_identity(
            &input.data_root,
            &input.environment,
            &target,
            &current,
            &observed,
            &lease,
        )?,
        Some(value)
            if value
                .native_identity()
                .is_some_and(|identity| identity.version == observed.version) =>
        {
            value.clone()
        }
        _ => return Err(error("memory_embedding_version_mismatch")),
    };
    if pinned.version() != observed.version {
        return Err(error("memory_embedding_version_mismatch"));
    }
    let current = resolve_generation(&input.data_root, &input.environment, &target)?;
    let receipt = store.upsert(&lease, &target, &current, &rows).await?;
    assert_current(input, &current, units, false)?;
    let final_generation = resolve_generation(&input.data_root, &input.environment, &target)?;
    if final_generation.generation_id != current.generation_id
        || final_generation
            .embedding
            .as_ref()
            .is_none_or(|value| value.version() != observed.version)
    {
        return Err(error("memory_generation_changed"));
    }
    let mut graph = GraphRepository::open(&current.graph_path)?;
    graph.complete_vector_quantum(units, &receipt, &(input.clock)())?;
    graph.close()?;
    drop(lease);
    Ok(())
}

async fn acquire(
    input: &Input,
    purpose: &str,
) -> CognitionResult<crate::coordination::CognitionWriteLease> {
    let lock = input.environment.consolidation_lock(&input.data_root);
    let cognition = input.environment.cognition_root(&input.data_root);
    ensure_data_authority(&input.data_root, &[&cognition, &lock])?;
    let lease = input
        .coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock.clone(),
                purpose: Some(purpose.into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(input.shutdown.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    lease
        .assert_for_path(&lock)
        .map_err(|_| error("memory_write_busy"))?;
    Ok(lease)
}

fn assert_generation_current(
    input: &Input,
    generation: &MemoryGenerationHandle,
    require_admission: bool,
) -> CognitionResult<()> {
    if require_admission && input.shutdown.is_cancelled() {
        return Err(error("memory_write_aborted"));
    }
    let target = input
        .target
        .clone()
        .unwrap_or(MemoryGenerationTarget::Active {
            expected_generation: generation.generation_id.clone(),
        });
    let current = resolve_generation(&input.data_root, &input.environment, &target)?;
    if current.generation_id != generation.generation_id {
        return Err(error("memory_generation_changed"));
    }
    if current
        .embedding
        .as_ref()
        .is_some_and(|value| value.native_identity().is_none())
    {
        return Err(error("memory_embedding_version_mismatch"));
    }
    ensure_data_authority(&input.data_root, &[&current.root, &current.graph_path])?;
    assert_mutation_authority(&input.data_root, &input.environment, &target, &current)
}

fn assert_current(
    input: &Input,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
    require_admission: bool,
) -> CognitionResult<()> {
    assert_generation_current(input, generation, require_admission)?;
    let graph = GraphRepository::open(&generation.graph_path)?;
    graph.assert_vector_quantum_current(&generation.generation_id, units)?;
    graph.close()?;
    let requires_conversation = units
        .iter()
        .any(|unit| unit.source_key.starts_with("conversation_"));
    let canonical = if requires_conversation {
        Some(
            ConversationSourceReader::open(&canonical_path(generation, &input.data_root))
                .map_err(|_| error("memory_source_changed"))?,
        )
    } else {
        None
    };
    for unit in units {
        if let Some((kind, record_id)) = unit.source_key.split_once(':')
            && matches!(kind, "task_report" | "explicit_record")
        {
            let owner = read_typed_record(
                &generation.source_root,
                &generation.source_root.join("cognition/memory"),
                kind,
                record_id,
            )?
            .ok_or_else(|| error("memory_source_changed"))?;
            if owner.revision != unit.source_revision || owner.content_hash != unit.source_hash {
                return Err(error("memory_source_changed"));
            }
            continue;
        }
        let reader = canonical
            .as_ref()
            .ok_or_else(|| error("memory_source_changed"))?;
        let session_id = unit
            .session_id
            .as_deref()
            .ok_or_else(|| error("memory_source_changed"))?;
        let notice = if let Some(turn_id) = unit.source_key.strip_prefix("conversation_turn:") {
            let outcome = reader
                .read_turn_outcome(turn_id)
                .map_err(|_| error("memory_source_changed"))?
                .ok_or_else(|| error("memory_source_changed"))?;
            ConversationSourceNotice::Turn {
                session_id,
                turn_id,
                outcome_generation: outcome.generation,
                extraction_version: &unit.extraction_version,
            }
        } else if let Some(message_id) = unit.source_key.strip_prefix("conversation_message:") {
            ConversationSourceNotice::Standalone {
                session_id,
                message_id,
                source_hash: &unit.source_hash,
                extraction_version: &unit.extraction_version,
            }
        } else {
            return Err(error("memory_source_changed"));
        };
        assert_conversation_source_current(
            reader,
            notice,
            &unit.source_revision,
            &(input.clock)(),
        )?;
    }
    if let Some(canonical) = canonical {
        canonical
            .close()
            .map_err(|_| error("memory_source_changed"))?;
    }
    Ok(())
}

fn row(
    unit: &ClaimedVectorUnit,
    generation: &MemoryGenerationHandle,
    version: &str,
    vector: Vec<f32>,
) -> CognitionResult<GenerationVectorRow> {
    let (chunk, key) = GenerationVectorRow::identity(
        &generation.generation_id,
        &unit.record_kind,
        &unit.owner_id,
        &unit.owner_revision,
        &unit.projection_text,
        version,
    );
    let observed = DateTime::parse_from_rfc3339(&unit.source_observed_at)
        .map_err(|_| error("memory_vector_rows_invalid"))?
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    Ok(GenerationVectorRow {
        vector_key: key,
        generation: generation.generation_id.clone(),
        record_kind: unit.record_kind.clone(),
        owner_id: unit.owner_id.clone(),
        owner_revision: unit.owner_revision.clone(),
        source_revision: unit.source_revision.clone(),
        embedding_chunk_id: chunk,
        embedding_version: version.into(),
        project_id: unit.project_id.clone().unwrap_or_default(),
        origin_kind: unit.origin_kind.clone(),
        source_kind: unit.source_kind.clone(),
        conversation_session_id: unit.conversation_session_id.clone(),
        source_observed_at: observed,
        source_refs_json: unit.source_refs_json.clone(),
        vector,
    })
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
