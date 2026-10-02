//! Cognition: extraction of memories from conversations into the memory graph
//! (SQLite) and vectors (LanceDB), recall for turn context, consolidation, and
//! the memory generations that rebuilds produce and cut over.

use std::{future::Future, pin::Pin};

mod box_store;
mod briefing;
mod completion;
mod configured_cycle;
mod configured_projects;
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
mod lance_maintenance;
mod lance_store;
mod legacy;
mod lexical;
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
mod source_reader;
mod source_reference;
mod sources;
mod vector_optimize;
mod windows;
pub use source_reader::MemorySourceReader;

pub(crate) use crate::cognition::legacy::lance_writer::{LegacyLanceWriter, LegacyVectorRow};
pub use crate::cognition::legacy::memory_import::{
    LegacyMemoryImportChunk, LegacyMemoryImportPlan, LegacyMemoryImportService,
};
pub use crate::cognition::legacy::metadata::{
    LegacyMetadataIntegrityService, MissingBoxRef, MissingFeedbackRef,
};
pub use crate::cognition::legacy::recall::{LegacyRecallRequest, recall_legacy};
pub use crate::cognition::legacy::session_sync::{
    LegacySessionOffsets, append_legacy_session_diagnostic, index_legacy_transcript_query,
    legacy_hot_prefix, normalize_session_id_for_storage, prepare_legacy_transcript,
    read_legacy_new_lines,
};
pub use box_store::BoxStoreService;
pub use briefing::{
    BriefingGenerationCode, BriefingGenerationError, BriefingGenerationService,
    BriefingInputFuture, BriefingInputSnapshot, BriefingInputSource, BriefingPersona,
    BriefingProjectSignal, BriefingSettings,
};
pub use briefing::{
    BriefingScope, BriefingSource, BriefingSuggestion, BriefingTitleVariants, NewChatBriefing,
    latest_completed_briefing_run_id, read_new_chat_briefing,
};
pub use completion::{
    CompletionNotice, CompletionPublisher, MemorySyncConsumer, MemorySyncPoll,
    TypedMemorySourceNotice, signal_memory_work,
};
pub use configured_cycle::{
    ConfiguredCycleOptions, ConfiguredCycleResult, ConfiguredCycleService, ConfiguredPhase,
    ConfiguredPhaseExecutor, ConfiguredPhaseFuture,
};
pub(crate) use configured_projects::{registered_project_names, registered_projects};
pub use consolidation::{
    CycleEventSink, CycleService, CycleStatus, Phase, PhaseError, PhaseExecutor, RunCycle,
};
pub use continuity_recovery::{
    ContinuityRecoveryAction, ContinuityRecoveryManifestView, ContinuityRecoveryService,
};
pub use embedding::{EmbeddingEngine, EmbeddingIdentity, EmbeddingResult, Tokenization};
pub use embedding_port::{
    CognitionEmbeddingPort, EmbeddingFuture, EmbeddingMode, EmbeddingRequest,
    EmbeddingRequestClass, WorkerOperation, WorkerRequest, WorkerResponse, WorkerResult,
};
pub use error::{CognitionCode, CognitionError, CognitionResult};
pub use exact_query::ExactMemoryQuery;
pub use extraction::{CandidateSearchInput, CognitionVectorSearch, VectorSearchFuture};
pub use feedback_buffer::{FeedbackBufferService, FeedbackTarget};
pub use generation::{
    AcceptanceBinding, ActiveDescriptor, BuildInventory, CanonicalSnapshot, EmbeddingSlot,
    FreshMemoryGeneration, GenerationEmbedding, GenerationFormat, GenerationManifest,
    GenerationReadiness, GenerationState, InitializationOrigin, MemoryGenerationHandle,
    MemoryGenerationTarget, ProjectionMode, RebuildInspection, SemanticCounts, StageCounts,
    VectorCounts, active_memory_descriptor_exists, advance_rebuild_cache,
    assert_mutation_authority, assert_rebuild_sources_registered, bind_native_embedding_identity,
    compute_rebuild_readiness, initialize_empty_memory_generation, inspect_memory_rebuild,
    prepare_fresh_memory_generation, prepare_memory_rebuild, read_build_inventory,
    rebuild_typed_cursor, record_rebuild_readiness, refresh_memory_rebuild_snapshot,
    resolve_active_generation, resolve_generation,
};
pub use generation_vectors::GenerationVectorAdapter;
pub use graph::{GraphProgress, JobOutcome, StageState, StageStatus};
pub use graph_consolidation::GraphConsolidationService;
pub use hot_cache::{LegacyIndexService, extract_legacy_import_transcript};
pub use knowhow_store::{FeedbackResolvePort, KnowHowService};
pub use mcp_graph::read_mcp_legacy_graph;
pub use memory_health::{MemoryHealthReport, MemoryHealthService};
pub use memory_recall::{MemoryRecall, RecallVectorFuture, RecallVectorPort};
pub use memory_recall::{RecallMetric, RecallMetricSink};
pub use migration::CognitionNamespaceMigrationService;
pub use mutable_paths::ensure_data_authority;
pub use paths::{CognitionPathEnvironment, explicit_memory_rules_root};
pub use project_capsule::ProjectCapsuleService;
pub use prompt::{CapsulePresence, CognitionPromptReader};
pub(crate) use recall::RecallRequest;
pub use registration::RegisterTypedSourceInput;
pub use registration::{
    CognitionConversationSourceNotice, CognitionRegistrationService, ConsumeTypedLifecycleInput,
    ConversationRegistrationOutcome, RegisterConversationSourceInput,
};
pub(crate) use source_reference::{MemorySourceCandidate, MemorySourceReference};
pub(in crate::cognition) use sources::assert_conversation_source_current;

pub use sources::{
    CognitionSourcePlan, CognitionSourceRow, ConversationSourceNotice, ExplicitMemoryUpdateInput,
    ExplicitMemoryUpdateResult, PreparedConversationSource, TaskMemoryIngestionResult,
    hydrate_conversation_source, ingest_task_outcome_memory, prepare_conversation_source,
    read_prior_public_context, update_explicit_memory,
};
pub use vector_optimize::{VectorOptimizeOutcome, VectorOptimizeService};
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
