//! Source-current checked vector quanta, sharing the Host embedding owner. Live
//! work embeds a few units per quantum. Daily and backfill batches claim many
//! units, embed them a request at a time and write them with one vector merge
//! and one completion; the table is compacted once, when the drain ends.

use crate::cognition::CognitionCode;
use std::ops::Range;

use super::{Input, canonical_path, resolve_input_generation};
use crate::cognition::generation_vectors::{
    GenerationVectorRow, GenerationVectorStore, compatibility, persisted_receipt, unit_receipt,
};
use crate::cognition::graph::{ClaimLimit, ClaimedVectorUnit, GraphRepository};
use crate::cognition::sources::read_typed_record;
use crate::cognition::{
    CognitionEmbeddingPort, CognitionError, CognitionResult, ConversationSourceNotice,
    EmbeddingIdentity, EmbeddingMode, EmbeddingRequest, EmbeddingRequestClass,
    MemoryGenerationHandle, MemoryGenerationTarget, assert_conversation_source_current,
    assert_mutation_authority, bind_native_embedding_identity, ensure_data_authority,
    resolve_generation,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire};
use butler_turn::conversation::ConversationSourceReader;
use chrono::{DateTime, SecondsFormat, Utc};

mod gates;
use gates::{Admission, acquire, assert_current, assert_generation_current, epoch_ms, error, row};

/// Texts one embedding request carries: the worker's background bound.
const EMBED_TEXTS: usize = 4;

/// What a claimed quantum left unfinished: the `failed` units end with
/// `error`; the units after them were never attempted and return to pending.
struct Unfinished {
    error: CognitionError,
    failed: Range<usize>,
}

impl Unfinished {
    fn all(error: CognitionError, units: &[ClaimedVectorUnit]) -> Self {
        Self {
            error,
            failed: 0..units.len(),
        }
    }
}

/// The vectors of a quantum's embedded prefix, their identity, and the failure
/// that stopped embedding, if any.
struct Embedded {
    vectors: Vec<Vec<f32>>,
    identity: Option<EmbeddingIdentity>,
    failure: Option<CognitionError>,
}

pub(in crate::cognition::completion::consumer) async fn process(
    input: &Input,
    embedding: &dyn CognitionEmbeddingPort,
) -> CognitionResult<bool> {
    if input.shutdown.is_cancelled() {
        return Ok(false);
    }
    let generation = resolve_input_generation(input)?;
    let result = process_generation(input, embedding, &generation).await;
    if let Err(failure) = &result
        && failure.code() == "memory_embedding_version_mismatch"
    {
        // The write-time recheck may have observed a newly pinned identity.
        let refused = resolve_input_generation(input)?;
        input.probe.identity_refused(&refused, failure.code());
        // A refused identity is a steady state; claimed work was failed below.
        return Ok(false);
    }
    result
}

async fn process_generation(
    input: &Input,
    embedding: &dyn CognitionEmbeddingPort,
    generation: &MemoryGenerationHandle,
) -> CognitionResult<bool> {
    if let Some(identity) = &generation.embedding {
        compatibility::preflight(identity)?;
    }
    let now = (input.clock)();
    // The claim takes the write lease; look first, without it.
    let units = if input
        .probe
        .vector_work(&generation.graph_path, &now)
        .await?
    {
        claim(input, generation, &now).await?
    } else {
        input
            .vector_batch
            .store(false, std::sync::atomic::Ordering::Release);
        None
    };
    let Some((units, current)) = units else {
        if input.daily_batch {
            maintain(input, generation, true).await;
        }
        return Ok(false);
    };
    let result = match current {
        Ok(()) => run_claimed(input, embedding, generation, &units).await,
        Err(failure) => Err(Unfinished::all(failure, &units)),
    };
    let Err(unfinished) = result else {
        return Ok(true);
    };
    record_unfinished(input, generation, &units, &unfinished).await?;
    if unfinished.error.code() == "embed_worker_cold" {
        Ok(false)
    } else {
        Err(unfinished.error)
    }
}

/// Claims the next quantum under the write lease (a batch in the daily window),
/// with its currency check; `None` when nothing was due.
async fn claim(
    input: &Input,
    generation: &MemoryGenerationHandle,
    now: &str,
) -> CognitionResult<Option<(Vec<ClaimedVectorUnit>, CognitionResult<()>)>> {
    let limit = if input.daily_batch {
        ClaimLimit::BATCH
    } else {
        ClaimLimit::LIVE
    };
    let _lease = acquire(input, "memory-vector-claim").await?;
    assert_generation_current(input, generation, Admission::Required)?;
    let mut graph = GraphRepository::open(&generation.graph_path)?;
    let units = graph.claim_vector_quantum(now, limit)?;
    graph.close()?;
    if units.is_empty() {
        return Ok(None);
    }
    let current = assert_current(input, generation, &units, Admission::Required);
    Ok(Some((units, current)))
}

/// Fails the units an attempt ended and returns never-attempted ones to
/// pending. A cancelled admission leaves the durable running claim for
/// recovery; bookkeeping never crosses the generation/source write gate.
async fn record_unfinished(
    input: &Input,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
    unfinished: &Unfinished,
) -> CognitionResult<()> {
    let open = units.get(unfinished.failed.start..).unwrap_or_default();
    if let Ok(_lease) = acquire(input, "memory-vector-fail").await
        && assert_current(input, generation, open, Admission::Failure).is_ok()
    {
        let now = (input.clock)();
        let mut graph = GraphRepository::open(&generation.graph_path)?;
        let failed = units.get(unfinished.failed.clone()).unwrap_or_default();
        if !failed.is_empty() {
            graph.fail_vector_quantum(failed, unfinished.error.code(), &now)?;
        }
        let deferred = units.get(unfinished.failed.end..).unwrap_or_default();
        if !deferred.is_empty() {
            graph.defer_vector_quantum(deferred, &now)?;
        }
        graph.close()?;
    }
    Ok(())
}

async fn run_claimed(
    input: &Input,
    embedding: &dyn CognitionEmbeddingPort,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
) -> Result<(), Unfinished> {
    let whole = |error| Unfinished::all(error, units);
    if complete_from_receipt(input, generation, units)
        .await
        .map_err(whole)?
    {
        return Ok(());
    }
    invoke(input, generation, units).await.map_err(whole)?;
    let embedded = embed(input, embedding, units).await;
    let done = embedded.vectors.len();
    if let Some(observed) = embedded.identity.as_ref().filter(|_| done > 0) {
        // The version is a compatibility domain, not producer provenance.
        let version = generation
            .embedding
            .as_ref()
            .map_or(observed.version.as_str(), |identity| identity.version());
        let completed = units.get(..done).unwrap_or_default();
        let rows = completed
            .iter()
            .zip(embedded.vectors)
            .map(|(unit, vector)| row(unit, generation, version, vector))
            .collect::<CognitionResult<Vec<_>>>()
            .map_err(whole)?;
        write_rows(input, generation, completed, observed, &rows)
            .await
            .map_err(whole)?;
    }
    match embedded.failure {
        None => Ok(()),
        Some(error) => Err(Unfinished {
            error,
            failed: done..(done + EMBED_TEXTS).min(units.len()),
        }),
    }
}

/// Marks the quantum invoked before the model sees it.
async fn invoke(
    input: &Input,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
) -> CognitionResult<()> {
    let _lease = acquire(input, "memory-vector-invocation").await?;
    assert_current(input, generation, units, Admission::Required)?;
    let mut graph = GraphRepository::open(&generation.graph_path)?;
    graph.mark_vector_invoked(units)?;
    graph.close()
}

/// Completes the quantum from vectors an earlier attempt already stored;
/// `false` when there are none.
async fn complete_from_receipt(
    input: &Input,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
) -> CognitionResult<bool> {
    let Some(identity) = generation.embedding.as_ref() else {
        return Ok(false);
    };
    let rows = units
        .iter()
        .map(|unit| row(unit, generation, identity.version(), Vec::new()))
        .collect::<CognitionResult<Vec<_>>>()?;
    if persisted_receipt(&input.data_root, generation, &rows)
        .await?
        .is_none()
    {
        return Ok(false);
    }
    let _lease = acquire(input, "memory-vector-receipt").await?;
    assert_current(input, generation, units, Admission::Required)?;
    let receipts = rows.iter().map(unit_receipt).collect::<Vec<_>>();
    let mut graph = GraphRepository::open(&generation.graph_path)?;
    graph.complete_vector_quantum(units, &receipts, &(input.clock)())?;
    graph.close()?;
    Ok(true)
}

/// Embeds the units a request at a time, stopping at the first failure. Every
/// request must share one identity.
async fn embed(
    input: &Input,
    embedding: &dyn CognitionEmbeddingPort,
    units: &[ClaimedVectorUnit],
) -> Embedded {
    let mut embedded = Embedded {
        vectors: Vec::with_capacity(units.len()),
        identity: None,
        failure: None,
    };
    for chunk in units.chunks(EMBED_TEXTS) {
        match embed_request(input, embedding, chunk).await {
            Ok(result)
                if embedded
                    .identity
                    .as_ref()
                    .is_none_or(|known| known.version == result.metadata.version) =>
            {
                embedded.vectors.extend(result.embeddings);
                embedded.identity = Some(result.metadata);
            }
            Ok(_) => {
                embedded.failure = Some(error(CognitionCode::MemoryEmbeddingVersionMismatch));
                break;
            }
            Err(failure) => {
                embedded.failure = Some(failure);
                break;
            }
        }
    }
    embedded
}

/// Embeds the units' projection texts in one request; the result must cover
/// each text exactly and use CLS pooling.
async fn embed_request(
    input: &Input,
    embedding: &dyn CognitionEmbeddingPort,
    units: &[ClaimedVectorUnit],
) -> CognitionResult<crate::cognition::EmbeddingResult> {
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
                max_embeddings: Some(EMBED_TEXTS),
                request_class: EmbeddingRequestClass::WarmBackground,
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
        return Err(error(CognitionCode::MemoryVectorReceiptMismatch));
    }
    if embedded.metadata.pooling != "cls" {
        return Err(error(CognitionCode::MemoryEmbeddingVersionMismatch));
    }
    Ok(embedded)
}

/// Writes the vectors under the lock, pinning the generation's embedding
/// identity on first use, and completes their units. A batch leaves table
/// maintenance to the end of its drain.
async fn write_rows(
    input: &Input,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
    observed: &EmbeddingIdentity,
    rows: &[GenerationVectorRow],
) -> CognitionResult<()> {
    let target = target(input, generation);
    let store = GenerationVectorStore::new(input.data_root.clone(), input.environment.clone());
    let lease = acquire(input, "memory-vector-write").await?;
    assert_current(input, generation, units, Admission::Required)?;
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
            observed,
            &lease,
        )?,
        Some(value) => {
            compatibility::query_identity(value, observed)?;
            value.clone()
        }
    };
    let current = resolve_generation(&input.data_root, &input.environment, &target)?;
    store.upsert(&lease, &target, &current, rows).await?;
    assert_current(input, &current, units, Admission::Ignored)?;
    let final_generation = resolve_generation(&input.data_root, &input.environment, &target)?;
    if final_generation.generation_id != current.generation_id
        || final_generation
            .embedding
            .as_ref()
            .is_none_or(|value| value.version() != pinned.version())
    {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    let receipts = rows.iter().map(unit_receipt).collect::<Vec<_>>();
    let mut graph = GraphRepository::open(&current.graph_path)?;
    graph.complete_vector_quantum(units, &receipts, &(input.clock)())?;
    graph.close()?;
    drop(lease);
    if !input.daily_batch {
        maintain(input, &current, false).await;
    }
    Ok(())
}

/// Maintenance never owns the write lease or delays shutdown. Cancellation
/// can leave unreferenced fragments, but cannot roll back the rows/receipts
/// already committed by write_rows. Lance's versioned compaction preserves
/// concurrent inserts and updates; pruning keeps unverified files.
async fn maintain(input: &Input, generation: &MemoryGenerationHandle, prune: bool) {
    if input.shutdown.is_cancelled() {
        return;
    }
    let store = GenerationVectorStore::new(input.data_root.clone(), input.environment.clone());
    let target = target(input, generation);
    tokio::select! {
        biased;
        () = input.shutdown.cancelled() => {},
        result = store.maintain(&target, generation, prune) => {
            if let Err(failure) = result {
                butler_core::diagnostic!("[memory-vector-batch] maintenance {}", failure.code());
            }
            input.coordinator.invalidate_inventory();
        }
    }
}

fn target(input: &Input, generation: &MemoryGenerationHandle) -> MemoryGenerationTarget {
    input
        .target
        .clone()
        .unwrap_or(MemoryGenerationTarget::Active {
            expected_generation: generation.generation_id.clone(),
        })
}
