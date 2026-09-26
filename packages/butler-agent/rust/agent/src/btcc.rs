//! Public BTCC message lifecycle boundary.
//!
//! Gateway and host composition may run or stop a Turn. Durable state, model
//! execution, delivery, and supervision remain private children of this module.

mod agent_loop;
mod authority;
mod continuation_budget;
mod contracts;
mod effects;
mod execution_controls;
mod guided_budget;
mod guided_turn;
mod identity;
mod model_route;
mod progress;
mod project_plan;
mod storage;
mod subsessions;
#[cfg(test)]
mod tests;
mod turn;
mod work;

use std::sync::Arc;

pub(crate) use contracts::{
    AcceptedWorkResult, AcceptedWorkStatus, AccessMode, AdmissionKind, AlreadyDeliveredOutcome,
    ArtifactKind, AttachmentKind, AttachmentRef, BtccError, DeliveredOutcome, ExecutionOutcome,
    FinalArtifact, ModelIdentity, Peer, PeerKind, ProgressDestination, ReasoningEffort,
    RuntimeFailure, Sender, SessionRole, StopRequest, TurnMessage, TurnOutcome, TurnOutcomeKind,
    TurnRequest, TurnRoute, TurnTrigger, WorkStatus,
};

pub(crate) use turn::{
    AdmissionContextPort, AdmissionModelCatalogPort, AdmissionModelCatalogSnapshot,
    AdmissionModelMetadata, AgentLoop, AgentLoopError, AgentLoopProgress, AgentLoopResult,
    ContentRef, ContextAssembly, ContextSection, ContinuationBudgetTransition,
    DefaultTurnPreparation, DeliveryOutbox, ExecutionRoute, FinalDisposition, HostDependencies,
    ModelRoundAcceptanceWrite, ModelRoundKey, ModelRouteEventWrite, ModelRouteWrite, PortFuture,
    PreparedConversation, ProgressEvent, StateExecutionClaim, SuspensionReason, TerminalOutcome,
    TurnCheckpoint, TurnDeveloperLogCapturePort, TurnDeveloperLogExecution, TurnDeveloperLogFuture,
    TurnFacadeDependencies, TurnRecord, TurnSemanticState, TurnStore, WakeIdentity,
};
#[cfg(test)]
pub(crate) use turn::{
    CanonicalMessageStore, DeliveryStatus, FinalPayload, PreparedTurn, ProgressEventRepository,
    ProgressWrite, StopPersistenceOutcome, StorageReadiness, TransitionCommitError, TurnTransition,
};

#[cfg(test)]
pub(crate) use agent_loop::NOOP_MODEL_ROUND_OBSERVER;
#[cfg(test)]
pub(crate) use agent_loop::OperationResultReference;
pub(crate) use agent_loop::{
    ActivityGroup, AuthorityDecision, AuthorityLoopContinuation, AuthorityPort, BatchDisposition,
    BoundGuidedTurn, BoundedContinuationEnvelope, BoundedEnvelopeV1, CandidateDisposition,
    ContextMessages, ContextPort, ContextProjection, ContextProjectionError,
    ContextProjectionInput, ContextProjectionRebaseIdentity, ContextProjectionRebaseV1,
    ExactResultReplaySelection, GuidedActivityBinding, GuidedActivitySnapshot, GuidedInvocation,
    GuidedPolicyDependencies, GuidedPresentation, GuidedTurnFactory, GuidedTurnInputs,
    GuidedTurnStart, JournalCloseout, JournalPort, ModelRoundError, ModelRoundMessage,
    ModelRoundObserver, ModelRoundPort, ModelRoundRequest, ModelRoundResult, ModelRoundRole,
    ModelRoundTool, ModelRoundToolCall, OperationResultMessageReferences,
    OperationResultReplayFactory, OperationResultRuntime, OperationResultRuntimeFactory,
    OperationResultScope, PendingTool, ProductionAgentLoop, PromptPort, ProviderBodyAdmissionPort,
    ProviderIdentity, ProviderStreamObserver, RenderedGuidedPrompt, ReplayMode, RollingContextV1,
    SemanticTurn, SteeringObservation, TextCallDisposition, ToolCallOrigin, ToolChoice,
    ToolExecutionError, ToolOutcome, ToolPort, ToolResult, TurnContextProjection, TurnSteeringPort,
    UsageAttribution, VerifiedImagePayloadPort, WorkFinalState, WorkPort,
    latest_work_anchor_indices,
};
pub(crate) use authority::contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityDecisionInput, AuthorityError,
    AuthorityExecutionInput, AuthorityOutcomeInput, NativePrincipalAuthority,
};
#[cfg(test)]
pub(crate) use continuation_budget::TurnContinuationBudgetLimits;
pub(crate) use continuation_budget::select_turn_continuation_budget;
pub(crate) use effects::NativeEffectService;
pub(crate) use effects::accepted_plan_effect_id;
pub(crate) use effects::contracts::{
    Access as EffectAccess, AdapterOutcome, BlockerRelation, EffectAdapter, EffectAdapterError,
    EffectBlocker, EffectError, EffectFailure, EffectFuture, EffectJournal, EffectOutcome,
    EffectRecord, EffectStatus, ExecuteEffect, PlanBinding, PreparedWrite, RecoveryHint,
    RegisteredEditPort, RegisteredWritePort,
};
pub(crate) use effects::effect_input_sha256;
pub(crate) use effects::reviewed_effect_action_key;
pub(crate) use effects::workspace_edit::{
    WorkspaceFileEditEffectAdapter, batch_target as workspace_edit_batch_target,
};
pub(crate) use effects::workspace_file::WorkspaceFileEffectAdapter;
pub(crate) use effects::workspace_file::normalized_workspace_effect_path;
pub(crate) use execution_controls::{
    ControlResolution, ControlSource, ExecutionControls, ModelFallback, SubsessionResultContext,
    VerifiedExecutionControls,
};
pub(crate) use guided_budget::{GuidedContinuationBudgetFactory, TurnContinuationBudgetPort};
pub(crate) use guided_turn::{
    GuidedAuthorityDecision, GuidedCatalogRead, GuidedCatalogSnapshot, GuidedPhaseInput,
    GuidedPhaseSelection, GuidedPreparationError, GuidedWork, guided_authority_loop_decision,
    load_guided_turn_work, select_phase, work_scope_for_turn,
};
pub(crate) use model_route::{
    ContextSizing, ContextSizingRequest, GuidedSourceRevision, ModelRequestAdmissionCode,
    ModelRequestAdmissionError, ModelRequestContextPlan, ModelRouteRetryConfig,
    ProviderRequestError, RequestContextAdmission, RequestContextMeasurement,
    TurnModelExecutionFactory,
};
pub(crate) use progress::{EventVisibility, RuntimeTurnEventInput};
pub(crate) use project_plan::{
    ProjectLedgerPlan, ProjectLedgerPlanInput, accepted_project_plan, render_accepted_project_plan,
};
pub(crate) use storage::{
    BtccRepositories, BtccStorage, BtccStorageConfig, CommittedProgressEvent,
    ContextCompactionRecord, ContextCompactionRepository, ContextDocumentRead,
    ExactProjectWorkResultAuthority, ExactProjectWorkResultIdentity,
    ExactProjectWorkResultVerification, OperationResultReferenceInput, OperationResultRepository,
    ParentResultRoute, PersistedWorkTurnScope, ProcessLiveness, ProjectWorkResultAuthorityFactory,
    ProjectWorkResultAuthorityLocation, RuntimeOwnerIdentity, SessionPlanObservation,
    SessionWorkRepository, SqliteProjectWorkRuntime, SqliteSubsessionRepository, StorageActivation,
    StorageEffectJournal, StorageError, StorageProfile, StorageProgressPublication,
    StoredSubsessionDelegation, StoredSubsessionDirection, SubsessionCreate,
    ToolJournalCloseoutRow, ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRecord,
    ToolJournalRepository, ToolJournalSignature, ToolJournalStart, WorkStatusObservation,
    bootstrap_fresh_storage, read_activated_storage_manifest,
};
#[cfg(test)]
pub(crate) use storage::{ContextDocumentInput, TestStorageFixture, test_prepared_turn};
pub(crate) use subsessions::{
    InterruptedSubsessionEvent, NativeSubsessionService, StewardDelegationRequest,
    SubsessionCancelRequest, SubsessionChildQueue, SubsessionDirectionRequest, SubsessionEnqueue,
    SubsessionResumeRequest, WorkerDelegationRequest, WorkerProfile, WorkerProfileReader,
};
pub(crate) use work::WorkStatus as DurableWorkStatus;
pub(crate) use work::policy::{
    accepted_current_result_review, allowed_next_work_stages, disposition_material_fingerprint,
};
pub(crate) use work::{
    ActionProgress, ActionStatus, Checkpoint, CheckpointInput, ClaimCloseoutCorrectionInput,
    ContinueWorkInput, CorrectionScope, DispositionActionUpdate, DispositionInput,
    DispositionStatus, DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput,
    ReviewInput, ReviewSubject, ReviewVerdict, RuntimeOwnedOpenGeneration, StartWorkInput,
    WorkContext, WorkDisposition, WorkOrigin, WorkPlan, WorkReview, WorkScope, WorkStage,
    WorkTurnScope, WorkView,
};
pub(crate) use work::{
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

pub(crate) fn digest_identity(value: &str) -> String {
    identity::digest(value)
}

pub(crate) fn build_project_work_material_snapshot(
    work: &WorkView,
    fingerprint: String,
    effect_watermark: Option<String>,
    blockers: Vec<ProjectWorkMaterialBlocker>,
) -> Result<ProjectWorkMaterialSnapshot, BtccError> {
    storage::project_work_material_snapshot(work, fingerprint, effect_watermark, blockers)
        .map_err(|error| BtccError::new(error.code, error.message))
}

#[derive(Clone)]
pub(crate) struct Btcc {
    inner: Arc<turn::Coordinator>,
}

impl Btcc {
    pub(crate) async fn run_turn(&self, request: TurnRequest) -> Result<TurnOutcome, BtccError> {
        self.inner.run_turn(request).await
    }

    pub(crate) async fn stop_turn(&self, request: StopRequest) -> Result<TurnOutcome, BtccError> {
        self.inner.stop_turn(&request.turn_id).await
    }
}

#[derive(Clone)]
pub(crate) struct BtccHost {
    inner: Arc<turn::Coordinator>,
}

impl BtccHost {
    pub(crate) async fn close(&self) -> Result<(), BtccError> {
        self.inner.close_host().await
    }
}

pub(crate) struct BtccAssembly {
    pub(crate) btcc: Btcc,
    pub(crate) host: BtccHost,
}

pub(crate) fn assemble(dependencies: TurnFacadeDependencies) -> BtccAssembly {
    let inner = turn::assemble(dependencies);
    BtccAssembly {
        btcc: Btcc {
            inner: inner.clone(),
        },
        host: BtccHost { inner },
    }
}
