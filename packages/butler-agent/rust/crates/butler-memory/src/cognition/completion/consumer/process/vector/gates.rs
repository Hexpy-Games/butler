//! The write lease and the generation, source and unit currency checks every
//! vector transition repeats, and the vector rows built from claimed units.

use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether a check also refuses once shutdown has begun.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Admission {
    Required,
    Ignored,
    /// Failure bookkeeping retains authority/source gates but permits identity refusal.
    Failure,
}

pub(super) async fn acquire(
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
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
    lease
        .assert_for_path(&lock)
        .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
    Ok(lease)
}

pub(super) fn assert_generation_current(
    input: &Input,
    generation: &MemoryGenerationHandle,
    admission: Admission,
) -> CognitionResult<()> {
    if admission != Admission::Ignored && input.shutdown.is_cancelled() {
        return Err(error(CognitionCode::MemoryWriteAborted));
    }
    let target = input
        .target
        .clone()
        .unwrap_or(MemoryGenerationTarget::Active {
            expected_generation: generation.generation_id.clone(),
        });
    let current = resolve_generation(&input.data_root, &input.environment, &target)?;
    if current.generation_id != generation.generation_id {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    }
    if admission != Admission::Failure
        && let Some(identity) = &current.embedding
    {
        compatibility::preflight(identity)?;
    }
    ensure_data_authority(&input.data_root, &[&current.root, &current.graph_path])?;
    assert_mutation_authority(&input.data_root, &input.environment, &target, &current)
}

pub(super) fn assert_current(
    input: &Input,
    generation: &MemoryGenerationHandle,
    units: &[ClaimedVectorUnit],
    admission: Admission,
) -> CognitionResult<()> {
    assert_generation_current(input, generation, admission)?;
    let graph = GraphRepository::open(&generation.graph_path)?;
    graph.assert_vector_quantum_current(&generation.generation_id, units)?;
    graph.close()?;
    let requires_conversation = units
        .iter()
        .any(|unit| unit.source_key.starts_with("conversation_"));
    let canonical = if requires_conversation {
        Some(
            ConversationSourceReader::open(&canonical_path(generation, &input.data_root))
                .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?,
        )
    } else {
        None
    };
    // Units of one source share its check; a batch reads each source once.
    let mut checked = std::collections::HashSet::new();
    for unit in units {
        if !checked.insert((
            &unit.source_key,
            &unit.source_revision,
            &unit.source_hash,
            &unit.extraction_version,
            &unit.session_id,
        )) {
            continue;
        }
        assert_source_current(input, generation, canonical.as_ref(), unit)?;
    }
    if let Some(canonical) = canonical {
        canonical
            .close()
            .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?;
    }
    Ok(())
}

/// One unit's source is unchanged: its typed record's revision and hash, or
/// its canonical conversation turn or message.
fn assert_source_current(
    input: &Input,
    generation: &MemoryGenerationHandle,
    canonical: Option<&ConversationSourceReader>,
    unit: &ClaimedVectorUnit,
) -> CognitionResult<()> {
    if let Some((kind, record_id)) = unit.source_key.split_once(':')
        && matches!(kind, "task_report" | "explicit_record")
    {
        let owner = read_typed_record(
            &generation.source_root,
            &generation.source_root.join("cognition/memory"),
            kind,
            record_id,
        )?
        .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
        if owner.revision != unit.source_revision || owner.content_hash != unit.source_hash {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
        return Ok(());
    }
    let reader = canonical.ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
    let session_id = unit
        .session_id
        .as_deref()
        .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
    let notice = if let Some(turn_id) = unit.source_key.strip_prefix("conversation_turn:") {
        let outcome = reader
            .read_turn_outcome(turn_id)
            .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?
            .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
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
        return Err(error(CognitionCode::MemorySourceChanged));
    };
    assert_conversation_source_current(reader, notice, &unit.source_revision, &(input.clock)())?;
    Ok(())
}

pub(super) fn row(
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
        .map_err(|source| error(CognitionCode::MemoryVectorRowsInvalid).with_source(source))?
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

pub(super) fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
pub(super) fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
