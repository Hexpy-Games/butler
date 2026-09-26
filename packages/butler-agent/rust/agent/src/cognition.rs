//! Native Cognition domain primitives.

use std::{future::Future, pin::Pin};

mod box_store;
mod briefing;
mod completion;
mod configured_cycle;
mod consolidation;
mod continuity_recovery;
mod embedding;
mod embedding_port;
mod error;
mod exact_query;
mod extraction;
mod feedback;
mod feedback_buffer;
mod generation;
mod generation_vectors;
mod graph;
mod graph_consolidation;
mod hot_cache;
mod knowhow_store;
mod lance_store;
mod legacy_lance_writer;
mod legacy_memory_import;
mod legacy_metadata;
mod legacy_recall;
mod legacy_session_sync;
mod lexical;
#[cfg(unix)]
mod mcp_graph;
mod memory_health;
mod memory_recall;
mod migration;
mod mutable_paths;
mod paths;
mod project_capsule;
mod prompt;
mod recall;
mod registration;
mod source_reference;
mod sources;
mod vector_optimize;
mod windows;

pub(crate) use box_store::BoxStoreService;
pub(crate) use briefing::{
    BriefingGenerationError, BriefingGenerationService, BriefingInputFuture, BriefingInputSnapshot,
    BriefingInputSource, BriefingPersona, BriefingProjectSignal, BriefingSettings,
};
pub(crate) use briefing::{latest_completed_briefing_run_id, read_new_chat_briefing};
pub(crate) use completion::{
    CompletionNotice, CompletionPublisher, MemorySyncPoll, NativeMemorySyncConsumer,
    TypedMemorySourceNotice,
};
pub(crate) use configured_cycle::{
    ConfiguredCycleOptions, ConfiguredCycleResult, ConfiguredCycleService, ConfiguredPhase,
    ConfiguredPhaseExecutor, ConfiguredPhaseFuture,
};
pub(crate) use consolidation::{
    CycleEventSink, CycleService, CycleStatus, Phase, PhaseError, PhaseExecutor, RunCycle,
};
pub(crate) use continuity_recovery::{
    ContinuityRecoveryAction, ContinuityRecoveryManifestView, ContinuityRecoveryService,
};
pub(crate) use embedding::{
    NativeEmbeddingEngine, NativeEmbeddingIdentity, NativeEmbeddingResult, NativeTokenization,
};
pub(crate) use embedding_port::{
    CognitionEmbeddingPort, EmbeddingFuture, EmbeddingMode, EmbeddingRequest,
    EmbeddingRequestClass, WorkerOperation, WorkerRequest, WorkerResponse, WorkerResult,
};
pub(crate) use error::{CognitionError, CognitionResult};
pub(crate) use exact_query::NativeExactMemoryQuery;
pub(crate) use extraction::{CandidateSearchInput, CognitionVectorSearch, VectorSearchFuture};
pub(crate) use feedback_buffer::{FeedbackBufferService, FeedbackTarget};
pub(crate) use generation::{
    BuildInventory, CandidateInputRepairRequest, GenerationEmbedding, MemoryGenerationHandle,
    MemoryGenerationTarget, activate_memory_rebuild, active_memory_descriptor_exists,
    advance_rebuild_cache, assert_mutation_authority, assert_rebuild_sources_registered,
    bind_native_embedding_identity, compute_rebuild_readiness, initialize_empty_memory_generation,
    inspect_memory_rebuild, prepare_memory_rebuild, read_build_inventory, rebuild_typed_cursor,
    reconcile_rebuild_vector_representatives, record_rebuild_readiness,
    refresh_memory_rebuild_snapshot, repair_memory_candidate_inputs, resolve_active_generation,
    resolve_generation, retry_failed_memory_generation, rollback_memory_rebuild,
    set_extractor_memory_generation, validate_memory_rebuild,
};
pub(crate) use generation_vectors::NativeGenerationVectorAdapter;
pub(crate) use graph::GraphProgress;
pub(crate) use graph::ProjectionModelPolicyInput;
pub(crate) use graph_consolidation::GraphConsolidationService;
pub(crate) use hot_cache::LegacyIndexService;
pub(crate) use hot_cache::extract_legacy_import_transcript;
pub(crate) use knowhow_store::{FeedbackResolvePort, KnowHowService};
pub(crate) use legacy_lance_writer::{LegacyLanceWriter, LegacyVectorRow};
pub(crate) use legacy_memory_import::{
    LegacyMemoryImportChunk, LegacyMemoryImportPlan, LegacyMemoryImportService,
};
pub(crate) use legacy_metadata::{
    LegacyMetadataIntegrityService, MissingBoxRef, MissingFeedbackRef,
};
pub(crate) use legacy_recall::{LegacyRecallRequest, recall_legacy};
pub(crate) use legacy_session_sync::{
    LegacySessionOffsets, append_legacy_session_diagnostic, index_legacy_transcript_query,
    legacy_hot_prefix, normalize_session_id_for_storage, prepare_legacy_transcript,
    read_legacy_new_lines,
};
#[cfg(unix)]
pub(crate) use mcp_graph::read_mcp_legacy_graph;
pub(crate) use memory_health::{MemoryHealthReport, MemoryHealthService};
pub(crate) use memory_recall::{NativeMemoryRecall, NativeRecallVectorPort, RecallVectorFuture};
pub(crate) use memory_recall::{RecallMetric, RecallMetricSink};
pub(crate) use migration::CognitionNamespaceMigrationService;
pub(crate) use mutable_paths::ensure_data_authority;
pub(crate) use paths::CognitionPathEnvironment;
pub(crate) use project_capsule::ProjectCapsuleService;
pub(crate) use prompt::{CapsulePresence, NativeCognitionPromptReader};
pub(crate) use recall::RecallRequest;
pub(crate) use registration::RegisterTypedSourceInput;
pub(crate) use registration::{
    CognitionConversationSourceNotice, CognitionRegistrationService, ConsumeTypedLifecycleInput,
    ConversationRegistrationOutcome, RegisterConversationSourceInput,
};
pub(crate) use source_reference::{MemorySourceCandidate, NativeMemorySourceReference};
pub(in crate::cognition) use sources::assert_conversation_source_current;

pub(crate) use sources::{
    CognitionSourceError, CognitionSourcePlan, CognitionSourceRow, ConversationSourceNotice,
    ExplicitMemoryUpdateInput, ExplicitMemoryUpdateResult, PreparedConversationSource,
    TaskMemoryIngestionResult, hydrate_conversation_source, ingest_task_outcome_memory,
    prepare_conversation_source, read_prior_public_context, update_explicit_memory,
};
pub(crate) use vector_optimize::{NativeVectorOptimizeService, VectorOptimizeOutcome};
pub(crate) use windows::{
    MEMORY_SOURCE_WINDOW_BYTES, grapheme_byte_boundaries, split_historical_source_spans,
};

pub(crate) type PhaseExecutionFuture<'a> = Pin<
    Box<
        dyn Future<Output = Result<serde_json::Map<String, serde_json::Value>, PhaseError>>
            + Send
            + 'a,
    >,
>;
