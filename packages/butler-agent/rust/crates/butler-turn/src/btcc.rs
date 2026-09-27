//! BTCC, the turn engine: one message in, one durable assistant turn out.
//!
//! Gateway and host composition may run or stop a Turn. Durable state, model
//! execution, delivery, and supervision remain private children of this module.

pub mod agent_loop;
mod authority;
mod continuation_budget;
mod contracts;
pub mod effects;
mod error;
mod execution_controls;
mod guided_budget;
mod guided_turn;
mod identity;
pub mod model_route;
mod progress;
mod project_plan;
pub mod storage;
mod subsessions;
mod turn;
mod work;

use std::sync::Arc;

pub use contracts::{
    AcceptedWorkResult, AcceptedWorkStatus, AccessMode, AdmissionKind, AlreadyDeliveredOutcome,
    ArtifactKind, AttachmentKind, AttachmentRef, ChangedFileLine, ChangedFileSummary,
    ChangedLineKind, DeliveredOutcome, ExecutionOutcome, FinalArtifact, ModelIdentity, Peer,
    PeerKind, ProgressDestination, ReasoningEffort, RuntimeFailure, Sender, SessionRole,
    StopRequest, TurnMessage, TurnOutcome, TurnOutcomeKind, TurnRequest, TurnRoute, TurnTrigger,
    WorkStatus,
};
pub use error::{BtccCode, BtccError, BtccSource};

pub use turn::{
    AdmissionContextPort, AdmissionModelCatalogPort, AdmissionModelCatalogSnapshot,
    AdmissionModelMetadata, AgentLoop, AgentLoopError, AgentLoopProgress, AgentLoopResult,
    ContentRef, ContextAssembly, ContextSection, ContinuationBudgetTransition,
    DefaultTurnPreparation, DeliveryOutbox, ExecutionRoute, FinalDisposition, HostDependencies,
    ModelRoundAcceptanceWrite, ModelRoundKey, ModelRouteEventWrite, ModelRouteWrite, PortFuture,
    PreparedConversation, ProgressEvent, StateExecutionClaim, SuspensionReason, TerminalOutcome,
    TurnCheckpoint, TurnDeveloperLogCapturePort, TurnDeveloperLogExecution, TurnDeveloperLogFuture,
    TurnFacadeDependencies, TurnRecord, TurnSemanticState, TurnStore, WakeIdentity,
};
pub use turn::{
    AttemptFailure, AttemptHistory, CanonicalMessageStore, DeliveryStatus, FailureDisposition,
    FailureRecord, FinalPayload, ModelRouteEvent, ModelRouteEventKind, PreparedTurn,
    ProgressEventRepository, ProgressWrite, RouteEventStatus, StopPersistenceOutcome,
    StorageReadiness, TransitionCommitError, TurnTransition,
};
pub use turn::{
    CommandMessage, CommandModelSelection, CommandTrigger, ResumeCommand, RouteCandidate,
    RouteIdentity, RouteState, RunCommand, TurnCommand, WakeCommand,
};

#[cfg(any(test, feature = "test-support"))]
pub use agent_loop::NOOP_MODEL_ROUND_OBSERVER;
#[cfg(any(test, feature = "test-support"))]
pub use agent_loop::OperationResultReference;
pub use agent_loop::{
    ActivityGroup, AuthorityDecision, AuthorityLoopContinuation, AuthorityPort, BatchDisposition,
    BoundGuidedTurn, BoundedContinuationEnvelope, BoundedEnvelopeV1, CandidateDisposition,
    ContextMessages, ContextPort, ContextProjection, ContextProjectionError,
    ContextProjectionInput, ContextProjectionRebaseIdentity, ContextProjectionRebaseV1,
    ContextRebase, ExactResultReplaySelection, FinalSynthesis, GuidedActivityBinding,
    GuidedActivitySnapshot, GuidedInvocation, GuidedPolicyDependencies, GuidedPresentation,
    GuidedTurnFactory, GuidedTurnInputs, GuidedTurnStart, JournalCloseout, JournalPort, LoopPhase,
    ModelRoundError, ModelRoundMessage, ModelRoundObserver, ModelRoundPort, ModelRoundRequest,
    ModelRoundResult, ModelRoundRole, ModelRoundTool, ModelRoundToolCall,
    OperationResultMessageReferences, OperationResultReplayFactory, OperationResultRuntime,
    OperationResultRuntimeFactory, OperationResultScope, PendingTool, ProductionAgentLoop,
    PromptImages, PromptPort, ProviderBodyAdmissionPort, ProviderIdentity, ProviderStreamObserver,
    RenderedGuidedPrompt, ReplayMode, RollingContextV1, RoundRequestOptions, SemanticTurn,
    SteeringObservation, TextCallDisposition, ToolCallOrigin, ToolChoice, ToolExecutionError,
    ToolOutcome, ToolPort, ToolResult, ToolSurface, TurnContextProjection, TurnSteeringPort,
    UsageAttribution, VerifiedImagePayloadPort, WorkFinalState, WorkPort,
    latest_work_anchor_indices,
};
pub use agent_loop::{
    AdmittedModelSelection, ButlerContext, EmptyResponsePolicy, ExecutionPolicy, TrackingMode,
};
pub use authority::contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityDecisionInput, AuthorityError,
    AuthorityExecutionInput, AuthorityOutcomeInput, AuthorityRequestProjection,
    AuthorityScopeProjection, PrincipalAuthority,
};
pub use continuation_budget::{
    TurnContinuationAdmission, TurnContinuationBudgetEvent, TurnContinuationBudgetLimits,
    TurnContinuationBudgetState, TurnContinuationBudgetTerminal,
    TurnContinuationBudgetTerminalReason, select_turn_continuation_budget,
};
pub use effects::contracts::{
    Access as EffectAccess, AdapterOutcome, BlockerRelation, EffectAdapter, EffectAdapterError,
    EffectBlocker, EffectError, EffectFailure, EffectFuture, EffectJournal, EffectOutcome,
    EffectRecord, EffectStatus, ExecuteEffect, PlanBinding, PreparedEdit, PreparedEditEntry,
    PreparedWrite, RecoveryHint, RegisteredEditPort, RegisteredWritePort,
};
pub use effects::workspace_edit::{
    WorkspaceFileEditEffectAdapter, batch_target as workspace_edit_batch_target,
};
pub use effects::workspace_file::{WorkspaceFileEffectAdapter, normalized_workspace_effect_path};
pub use effects::{EffectService, accepted_plan_effect_id};
pub use effects::{effect_input_sha256, reviewed_effect_action_key};
pub use execution_controls::{
    ControlResolution, ControlSource, ExecutionControls, ModelFallback, SubsessionResultContext,
    VerifiedExecutionControls,
};
pub use guided_budget::{GuidedContinuationBudgetFactory, TurnContinuationBudgetPort};
pub use guided_turn::{
    GuidedAuthorityDecision, GuidedCatalogRead, GuidedCatalogSnapshot, GuidedPhase,
    GuidedPhaseInput, GuidedPhaseSelection, GuidedPreparationError, GuidedWork, LedgerEffects,
    SurfaceMode, guided_authority_loop_decision, load_guided_turn_work, select_phase,
    work_scope_for_turn,
};
pub use model_route::{
    ContextSizing, ContextSizingRequest, GuidedSourceRevision, ModelRequestAdmissionCode,
    ModelRequestAdmissionError, ModelRequestContextPlan, ModelRouteRetryConfig,
    ProviderRequestError, RequestContextAdmission, RequestContextMeasurement,
    TurnModelExecutionFactory,
};
pub use progress::{EventVisibility, RuntimeTurnEventInput};
pub use project_plan::{
    ProjectLedgerPlan, ProjectLedgerPlanInput, accepted_project_plan, render_accepted_project_plan,
};
pub use storage::{
    BtccRepositories, BtccStorage, BtccStorageConfig, CommittedProgressEvent,
    ContextCompactionRecord, ContextCompactionRepository, ContextDocumentRead,
    ExactProjectWorkResultAuthority, ExactProjectWorkResultIdentity,
    ExactProjectWorkResultVerification, OperationResultReferenceInput, OperationResultRepository,
    ParentResultRoute, PersistedWorkTurnScope, ProcessLiveness, ProjectWorkResultAuthorityFactory,
    ProjectWorkResultAuthorityLocation, RuntimeOwnerIdentity, SessionPlanObservation,
    SessionWorkRepository, SqliteProjectWorkRuntime, SqliteSubsessionRepository, StorageActivation,
    StorageCode, StorageEffectJournal, StorageError, StorageProfile, StorageProgressPublication,
    StoredSubsessionDelegation, StoredSubsessionDirection, SubsessionCreate,
    ToolJournalCloseoutRow, ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRecord,
    ToolJournalRepository, ToolJournalSignature, ToolJournalStart, WorkStatusObservation,
    bootstrap_fresh_storage, read_activated_storage_manifest,
};
pub use storage::{
    ChildEnvelope, ChildRole, DispatchIntent, DispatchMetadata, EnvelopeMessage, EnvelopePeer,
    EnvelopeRaw, EnvelopeRouting, EnvelopeSender, NativeStewardContext, PacketExecutionMode,
    PacketPlanAction, PacketWorkerProfile, ParentResultInput, ParentWorkRef, StewardResultInput,
    SubsessionPacket, WorkerResultInput,
};
#[cfg(any(test, feature = "test-support"))]
pub use storage::{ContextDocumentInput, TestStorageFixture, test_prepared_turn};
pub use subsessions::{
    InterruptedSubsessionEvent, StewardDelegationRequest, SubsessionCancelRequest,
    SubsessionChildQueue, SubsessionDirectionRequest, SubsessionEnqueue, SubsessionResumeRequest,
    SubsessionService, WorkerDelegationRequest, WorkerProfile, WorkerProfileReader,
};
pub use work::WorkStatus as DurableWorkStatus;
pub use work::policy::{
    accepted_current_result_review, allowed_next_work_stages, disposition_material_fingerprint,
};
pub use work::{
    ActionProgress, ActionStatus, Checkpoint, CheckpointInput, ClaimCloseoutCorrectionInput,
    ContinueWorkInput, CorrectionScope, DispositionActionUpdate, DispositionInput,
    DispositionStatus, DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput,
    ReviewInput, ReviewSubject, ReviewVerdict, RuntimeOwnedOpenGeneration, StartWorkInput,
    WorkContext, WorkDisposition, WorkOrigin, WorkPlan, WorkReview, WorkScope, WorkStage,
    WorkTurnScope, WorkView,
};
pub use work::{
    CheckpointCommand, ContinueWorkCommand, DispositionCommand, DurableWorkRepository,
    LegacyImport, LegacyProjectWorkRecord, LegacyProjectWorkReferencedRecord,
    LegacyProjectWorkSource, LegacyProjectWorkSourceSnapshot, ProjectWorkBinding,
    ProjectWorkCapturedMaterial, ProjectWorkCommittedResultInput,
    ProjectWorkDispositionPreparation, ProjectWorkLegacyInput, ProjectWorkLegacyObserveInput,
    ProjectWorkLegacyRuntime, ProjectWorkLegacySnapshot, ProjectWorkLocateInput,
    ProjectWorkMaterialBlocker, ProjectWorkMaterialInput, ProjectWorkMaterialSnapshot,
    ProjectWorkObserveWork, ProjectWorkObserveWorks, ProjectWorkOperationIdentity,
    ProjectWorkOperationKind, ProjectWorkResultRuntime, ProjectWorkRuntimeProjection,
    ReplacePlanCommand, ResolvedProjectWorkScope, ReviewCommand, StartWorkCommand,
};

/// The SHA-256 hex digest used for BTCC identities.
pub fn digest_identity(value: &str) -> String {
    identity::digest(value)
}

/// The material snapshot of a project Work (what a disposition is decided on).
pub fn build_project_work_material_snapshot(
    work: &WorkView,
    fingerprint: String,
    effect_watermark: Option<String>,
    blockers: Vec<ProjectWorkMaterialBlocker>,
) -> Result<ProjectWorkMaterialSnapshot, BtccError> {
    storage::project_work_material_snapshot(work, fingerprint, effect_watermark, blockers)
        .map_err(BtccError::from)
}

/// Runs and stops turns through the turn coordinator.
#[derive(Clone)]
pub struct Btcc {
    inner: Arc<turn::Coordinator>,
}

impl Btcc {
    /// Runs a turn to delivery, suspension or cancellation; concurrent requests for the same turn share one run.
    pub async fn run_turn(&self, request: TurnRequest) -> Result<TurnOutcome, BtccError> {
        self.inner.run_turn(request).await
    }

    /// Stops a turn and reports how it ended.
    pub async fn stop_turn(&self, request: StopRequest) -> Result<TurnOutcome, BtccError> {
        self.inner.stop_turn(&request.turn_id).await
    }
}

/// The shutdown handle of the turn coordinator.
#[derive(Clone)]
pub struct BtccHost {
    inner: Arc<turn::Coordinator>,
}

impl BtccHost {
    /// Refuses new turns, waits for active ones and closes the dependencies.
    pub async fn close(&self) -> Result<(), BtccError> {
        self.inner.close_host().await
    }
}

/// The turn runtime and its host handle.
pub struct BtccAssembly {
    pub btcc: Btcc,
    pub host: BtccHost,
}

/// Assembles the turn runtime from its dependencies.
pub fn assemble(dependencies: &TurnFacadeDependencies) -> BtccAssembly {
    let inner = turn::assemble(dependencies);
    BtccAssembly {
        btcc: Btcc {
            inner: inner.clone(),
        },
        host: BtccHost { inner },
    }
}
