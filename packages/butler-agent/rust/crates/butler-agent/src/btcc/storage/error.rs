//! Failures of BTCC's SQLite storage lane.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Storage failures.
    pub(crate) enum StorageCode {
        GuidedToolCallIdentityConflict = "Guided tool call identity conflict",
        GuidedToolResultIdentityConflict = "Guided tool result identity conflict",
        AdmissionClaimInactive = "admission_claim_inactive",
        AdmissionClaimLive = "admission_claim_live",
        AdmissionClaimMissing = "admission_claim_missing",
        AdmissionClaimRaced = "admission_claim_raced",
        AdmissionKeyConflict = "admission_key_conflict",
        AdmittedHasDelivery = "admitted_has_delivery",
        AgentBtccExistingStorageUnsupported = "agent_btcc_existing_storage_unsupported",
        AgentBtccMigrationReferenceCheckFailed = "agent_btcc_migration_reference_check_failed",
        AgentBtccStorageActivationInvalid = "agent_btcc_storage_activation_invalid",
        AgentBtccStorageActivationMissing = "agent_btcc_storage_activation_missing",
        AgentBtccStorageFenceInvalid = "agent_btcc_storage_fence_invalid",
        AgentBtccStorageForeignKeyCheckFailed = "agent_btcc_storage_foreign_key_check_failed",
        AgentBtccStorageIoError = "agent_btcc_storage_io_error",
        AgentBtccStorageManifestMismatch = "agent_btcc_storage_manifest_mismatch",
        AgentBtccStorageNonemptyFreshTarget = "agent_btcc_storage_nonempty_fresh_target",
        AgentBtccStoragePathInvalid = "agent_btcc_storage_path_invalid",
        AgentBtccStoragePublishTargetExists = "agent_btcc_storage_publish_target_exists",
        AgentBtccStorageQuickCheckFailed = "agent_btcc_storage_quick_check_failed",
        AgentBtccStorageReceiptInvalid = "agent_btcc_storage_receipt_invalid",
        AgentBtccStorageReceiptMissing = "agent_btcc_storage_receipt_missing",
        AgentBtccStorageUnreceiptedTarget = "agent_btcc_storage_unreceipted_target",
        AuthorityContinuationInvalid = "authority_continuation_invalid",
        AuthorityContinuationMissing = "authority_continuation_missing",
        AuthoritySourceCallMismatch = "authority_source_call_mismatch",
        AuthoritySourceCallNotPending = "authority_source_call_not_pending",
        BtccContextDocumentIdentityInvalid = "btcc_context_document_identity_invalid",
        CanonicalDeliveryConflict = "canonical_delivery_conflict",
        CanonicalJson = "canonical_json",
        CanonicalMessageConflict = "canonical_message_conflict",
        CanonicalMessageNotInserted = "canonical_message_not_inserted",
        CanonicalOutboxMismatch = "canonical_outbox_mismatch",
        CanonicalOutboxMissing = "canonical_outbox_missing",
        CanonicalUserConflict = "canonical_user_conflict",
        CheckpointClaimed = "checkpoint_claimed",
        CheckpointLifecycleMismatch = "checkpoint_lifecycle_mismatch",
        CheckpointMismatch = "checkpoint_mismatch",
        CheckpointMissing = "checkpoint_missing",
        ClockBeforeEpoch = "clock_before_epoch",
        CommittedAlreadyObserved = "committed_already_observed",
        ConstructedTurnMissing = "constructed_turn_missing",
        ConstructionClaimMissing = "construction_claim_missing",
        ContextCompactionRecordInvalid = "context_compaction_record_invalid",
        ContextDocumentUnavailable = "context_document_unavailable",
        ContinuationSerialize = "continuation_serialize",
        ContinuationTerminalMissing = "continuation_terminal_missing",
        ContinuationTriggerConflict = "continuation_trigger_conflict",
        DeliveredUnobserved = "delivered_unobserved",
        DurableWorkAbandonFailed = "durable_work_abandon_failed",
        DurableWorkBindingNotHead = "durable_work_binding_not_head",
        DurableWorkBlockedNextMissing = "durable_work_blocked_next_missing",
        DurableWorkCloseoutNotBound = "durable_work_closeout_not_bound",
        DurableWorkContinuationNotCurrent = "durable_work_continuation_not_current",
        DurableWorkControlResult = "durable_work_control_result",
        DurableWorkDispositionIdentityConflict = "durable_work_disposition_identity_conflict",
        DurableWorkDispositionNotBound = "durable_work_disposition_not_bound",
        DurableWorkEffectBlocker = "durable_work_effect_blocker",
        DurableWorkEvidenceAmbiguous = "durable_work_evidence_ambiguous",
        DurableWorkEvidenceIneligible = "durable_work_evidence_ineligible",
        DurableWorkHeadMissing = "durable_work_head_missing",
        DurableWorkHydrationFailed = "durable_work_hydration_failed",
        DurableWorkLegacyIdentityConflict = "durable_work_legacy_identity_conflict",
        DurableWorkLegacyOriginSession = "durable_work_legacy_origin_session",
        DurableWorkMaterialChanged = "durable_work_material_changed",
        DurableWorkMaterialFingerprint = "durable_work_material_fingerprint",
        DurableWorkMutationIdentityConflict = "durable_work_mutation_identity_conflict",
        DurableWorkNextMissing = "durable_work_next_missing",
        DurableWorkNonterminalActions = "durable_work_nonterminal_actions",
        DurableWorkNotBound = "durable_work_not_bound",
        DurableWorkNotOpen = "durable_work_not_open",
        DurableWorkOriginalRequestUnavailable = "durable_work_original_request_unavailable",
        DurableWorkPendingEffect = "durable_work_pending_effect",
        DurableWorkPlanChanged = "durable_work_plan_changed",
        DurableWorkPlanLost = "durable_work_plan_lost",
        DurableWorkPlanReviewMissing = "durable_work_plan_review_missing",
        DurableWorkProgressChanged = "durable_work_progress_changed",
        DurableWorkProgressInvalid = "durable_work_progress_invalid",
        DurableWorkRecordMissing = "durable_work_record_missing",
        DurableWorkRelationCommitted = "durable_work_relation_committed",
        DurableWorkRelationIdentityConflict = "durable_work_relation_identity_conflict",
        DurableWorkRelationOther = "durable_work_relation_other",
        DurableWorkRelationSelected = "durable_work_relation_selected",
        DurableWorkRemainingActions = "durable_work_remaining_actions",
        DurableWorkResultOther = "durable_work_result_other",
        DurableWorkResultReviewChanged = "durable_work_result_review_changed",
        DurableWorkResultReviewMissing = "durable_work_result_review_missing",
        DurableWorkResultsChanged = "durable_work_results_changed",
        DurableWorkScopeChanged = "durable_work_scope_changed",
        DurableWorkScopeMismatch = "durable_work_scope_mismatch",
        DurableWorkSerializationFailed = "durable_work_serialization_failed",
        DurableWorkTerminalRelation = "durable_work_terminal_relation",
        DurableWorkToolIneligible = "durable_work_tool_ineligible",
        DurableWorkToolNotCommitted = "durable_work_tool_not_committed",
        DurableWorkTurnFenced = "durable_work_turn_fenced",
        DurableWorkTurnNotAdmitted = "durable_work_turn_not_admitted",
        DurableWorkTurnSessionMismatch = "durable_work_turn_session_mismatch",
        FinalOutboxMismatch = "final_outbox_mismatch",
        ImmutableRecordConflict = "immutable_record_conflict",
        InboxMissing = "inbox_missing",
        InvalidAuthorityContinuation = "invalid_authority_continuation",
        InvalidContinuationBudget = "invalid_continuation_budget",
        InvalidContinuationBudgetEvent = "invalid_continuation_budget_event",
        InvalidDeliveryObservation = "invalid_delivery_observation",
        InvalidFinalDisposition = "invalid_final_disposition",
        InvalidFinalPayload = "invalid_final_payload",
        InvalidFinalTransition = "invalid_final_transition",
        InvalidModelRoute = "invalid_model_route",
        InvalidModelSelection = "invalid_model_selection",
        InvalidProgressDestination = "invalid_progress_destination",
        InvalidRoute = "invalid_route",
        InvalidSuspensionReason = "invalid_suspension_reason",
        InvalidSuspensionTransition = "invalid_suspension_transition",
        InvalidTurnCommand = "invalid_turn_command",
        InvalidTurnContext = "invalid_turn_context",
        InvalidTurnState = "invalid_turn_state",
        JsonStringify = "json_stringify",
        LegacyTurnCutoverCasConflict = "legacy_turn_cutover_cas_conflict",
        LegacyTurnQuarantineCasConflict = "legacy_turn_quarantine_cas_conflict",
        ModelAcceptanceClaim = "model_acceptance_claim",
        ModelAcceptanceJson = "model_acceptance_json",
        ModelCheckpointMissing = "model_checkpoint_missing",
        ModelCheckpointStale = "model_checkpoint_stale",
        ModelClaimLost = "model_claim_lost",
        ModelEventInvalid = "model_event_invalid",
        ModelResponseInvalid = "model_response_invalid",
        ModelRouteCas = "model_route_cas",
        ModelRouteInvalid = "model_route_invalid",
        OperationResultBodyHashMismatch = "operation_result_body_hash_mismatch",
        OperationResultCallIdInvalid = "operation_result_call_id_invalid",
        OperationResultDeliveryAcknowledgementConflict = "operation_result_delivery_acknowledgement_conflict",
        OperationResultDeliveryAdmissionFailed = "operation_result_delivery_admission_failed",
        OperationResultDeliveryBeginConflict = "operation_result_delivery_begin_conflict",
        OperationResultDeliveryPromotionConflict = "operation_result_delivery_promotion_conflict",
        OperationResultDeliveryReleaseConflict = "operation_result_delivery_release_conflict",
        OperationResultIntegrityMismatch = "operation_result_integrity_mismatch",
        OperationResultMissingOrScopeMismatch = "operation_result_missing_or_scope_mismatch",
        OperationResultProjectAuthorityMissing = "operation_result_project_authority_missing",
        OperationResultProjectProjectionMismatch = "operation_result_project_projection_mismatch",
        OperationResultProjectReferenceMismatch = "operation_result_project_reference_mismatch",
        OperationResultRangeOutOfBounds = "operation_result_range_out_of_bounds",
        OperationResultResponseHashInvalid = "operation_result_response_hash_invalid",
        OperationResultRevisionMismatch = "operation_result_revision_mismatch",
        OperationResultRoundIdInvalid = "operation_result_round_id_invalid",
        OperationResultScopeMismatch = "operation_result_scope_mismatch",
        OperationResultSessionMismatch = "operation_result_session_mismatch",
        OperationResultTurnIdInvalid = "operation_result_turn_id_invalid",
        OperationResultWorkMismatch = "operation_result_work_mismatch",
        OutboxInvalid = "outbox_invalid",
        OutboxMissing = "outbox_missing",
        ParentAppBindingRequired = "parent_app_binding_required",
        ProgressDestination = "progress_destination",
        ProgressDestinationInvalid = "progress_destination_invalid",
        ProgressEvent = "progress_event",
        ProgressEventInvalid = "progress_event_invalid",
        ProjectWorkEffectUnresolved = "project_work_effect_unresolved",
        ProjectWorkLegacyBindingInvalid = "project_work_legacy_binding_invalid",
        ProjectWorkLegacyBindingMissing = "project_work_legacy_binding_missing",
        ProjectWorkLegacyBindingSessionMismatch = "project_work_legacy_binding_session_mismatch",
        ProjectWorkLegacyDispositionEffectHistoryUnavailable = "project_work_legacy_disposition_effect_history_unavailable",
        ProjectWorkLegacyDispositionMaterialMismatch = "project_work_legacy_disposition_material_mismatch",
        ProjectWorkLegacyDispositionResultMissing = "project_work_legacy_disposition_result_missing",
        ProjectWorkLegacyHistoryInvalid = "project_work_legacy_history_invalid",
        ProjectWorkLegacyIdentityConflict = "project_work_legacy_identity_conflict",
        ProjectWorkLegacyMultipleOpenWorks = "project_work_legacy_multiple_open_works",
        ProjectWorkLegacyObservationInvalid = "project_work_legacy_observation_invalid",
        ProjectWorkLegacyOriginMessageInvalid = "project_work_legacy_origin_message_invalid",
        ProjectWorkLegacyPlanMissing = "project_work_legacy_plan_missing",
        ProjectWorkLegacyProjectNotObserved = "project_work_legacy_project_not_observed",
        ProjectWorkLegacyResultInvalid = "project_work_legacy_result_invalid",
        ProjectWorkLegacyResultReferenceMismatch = "project_work_legacy_result_reference_mismatch",
        ProjectWorkLegacyScopeConflict = "project_work_legacy_scope_conflict",
        ProjectWorkLegacySourceChanged = "project_work_legacy_source_changed",
        ProjectWorkLegacySourceInvalid = "project_work_legacy_source_invalid",
        ProjectWorkLegacySourceRevisionInvalid = "project_work_legacy_source_revision_invalid",
        ProjectWorkLegacyStaleBindingInvalid = "project_work_legacy_stale_binding_invalid",
        ProjectWorkLegacyTurnOwnershipInvalid = "project_work_legacy_turn_ownership_invalid",
        ProjectWorkMaterialInvalid = "project_work_material_invalid",
        ProjectWorkProgressInvalid = "project_work_progress_invalid",
        ProjectWorkRepositoryRequired = "project_work_repository_required",
        ProjectWorkResultBodyHashMismatch = "project_work_result_body_hash_mismatch",
        ProjectWorkResultNotAttachable = "project_work_result_not_attachable",
        ProjectWorkResultNotCommitted = "project_work_result_not_committed",
        ProjectWorkResultReferenceMismatch = "project_work_result_reference_mismatch",
        ProjectWorkRuntimeHeadInvalid = "project_work_runtime_head_invalid",
        ProjectWorkRuntimeOriginMissing = "project_work_runtime_origin_missing",
        ProjectWorkRuntimeOwnershipConflict = "project_work_runtime_ownership_conflict",
        ProjectWorkRuntimeProjectionMismatch = "project_work_runtime_projection_mismatch",
        ProjectWorkRuntimeResultInvalid = "project_work_runtime_result_invalid",
        ProviderIdentityJson = "provider_identity_json",
        RestartToolResultMissing = "restart_tool_result_missing",
        RuntimeOwnerActive = "runtime_owner_active",
        RuntimeOwnerGenerationOverflow = "runtime_owner_generation_overflow",
        RuntimeOwnerRegistrationMissing = "runtime_owner_registration_missing",
        RuntimeOwnerRegistrationRaced = "runtime_owner_registration_raced",
        SqliteCloseCompletionLost = "sqlite_close_completion_lost",
        SqliteError = "sqlite_error",
        SqliteInitializationChannelClosed = "sqlite_initialization_channel_closed",
        SqliteJoinFailed = "sqlite_join_failed",
        SqliteOperationCompletionLost = "sqlite_operation_completion_lost",
        SqliteOwnerClosed = "sqlite_owner_closed",
        SqliteParentCreateFailed = "sqlite_parent_create_failed",
        SqliteThreadMissing = "sqlite_thread_missing",
        SqliteThreadPanicked = "sqlite_thread_panicked",
        SqliteThreadSpawnFailed = "sqlite_thread_spawn_failed",
        SqliteTransactionOpenAtClose = "sqlite_transaction_open_at_close",
        StateClaimAdoptionRaced = "state_claim_adoption_raced",
        StateClaimInactive = "state_claim_inactive",
        StateClaimLive = "state_claim_live",
        StateClaimMissing = "state_claim_missing",
        StateClaimStaleTurn = "state_claim_stale_turn",
        StopCasLost = "stop_cas_lost",
        StopFinalMissing = "stop_final_missing",
        StopMessageMissing = "stop_message_missing",
        SubsessionChildRoleInvalid = "subsession_child_role_invalid",
        SubsessionOutboxInvalid = "subsession_outbox_invalid",
        SubsessionOutboxRouteInvalid = "subsession_outbox_route_invalid",
        SubsessionPacketInvalid = "subsession_packet_invalid",
        SubsessionParentModelContextMissing = "subsession_parent_model_context_missing",
        SubsessionRelationMissing = "subsession_relation_missing",
        SubsessionResultInvalid = "subsession_result_invalid",
        TerminalClaim = "terminal_claim",
        ToolJournalJsonInvalid = "tool_journal_json_invalid",
        TransitionCheckpointInactive = "transition_checkpoint_inactive",
        TransitionClaimInactive = "transition_claim_inactive",
        TransitionClaimLost = "transition_claim_lost",
        TransitionContention = "transition_contention",
        TurnContinuationAtomicUpdateFailed = "turn_continuation_atomic_update_failed",
        TurnContinuationDependencyMissing = "turn_continuation_dependency_missing",
        TurnInboxConflict = "turn_inbox_conflict",
        TurnMissing = "turn_missing",
        TurnNotAdmitted = "turn_not_admitted",
        TurnReplayConflict = "turn_replay_conflict",
        TurnRevisionOverflow = "turn_revision_overflow",
        WakeRequestConflict = "wake_request_conflict",
        WakeTriggerConflict = "wake_trigger_conflict",
        WorkScopeProjectProjectionIncomplete = "work_scope_project_projection_incomplete",
        WorkScopeTurnBindingAmbiguous = "work_scope_turn_binding_ambiguous",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type StorageSource = Arc<dyn Error + Send + Sync>;

/// Failures of BTCC's SQLite storage lane.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum StorageError {
    /// A storage check failed: missing or conflicting row, invalid stored value,
    /// unexpected schema, closed lane. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected { code: StorageCode, message: String },
    /// SQLite failed; the message is SQLite's own text.
    #[error("sqlite_error: {source}")]
    Sqlite {
        #[source]
        source: Arc<rusqlite::Error>,
    },
    /// A storage port implemented outside BTCC (for example the Project Ledger
    /// result authority) failed; `code` and `message` are that implementation's own.
    #[error("{code}: {message}")]
    Port {
        code: &'static str,
        message: String,
        #[source]
        source: Option<StorageSource>,
    },
    /// A lower-level operation (JSON decoding, filesystem, thread, task join)
    /// failed; `code` names what storage was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: StorageCode,
        message: String,
        #[source]
        source: StorageSource,
    },
}

impl StorageError {
    pub(crate) fn new(code: StorageCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn sqlite(error: rusqlite::Error) -> Self {
        Self::Sqlite {
            source: Arc::new(error),
        }
    }

    /// A port implementation's failure that has no underlying error.
    pub(crate) fn relayed(code: &'static str, message: impl Into<String>) -> Self {
        Self::Port {
            code,
            message: message.into(),
            source: None,
        }
    }

    /// Records `source` as the cause of a detected failure, keeping its code
    /// and message. An error that already carries a cause is returned as is.
    #[must_use]
    pub(crate) fn with_source(self, source: impl Error + Send + Sync + 'static) -> Self {
        match self {
            Self::Detected { code, message } => Self::Failed {
                code,
                message,
                source: Arc::new(source),
            },
            other => other,
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Sqlite { .. } => StorageCode::SqliteError.as_str(),
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
            Self::Port { code, .. } => code,
        }
    }

    /// The user-facing message.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Detected { message, .. }
            | Self::Failed { message, .. }
            | Self::Port { message, .. } => message.clone(),
            Self::Sqlite { source } => source.to_string(),
        }
    }
}

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for StorageError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for StorageError {}

#[cfg(test)]
mod tests {
    use super::StorageCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = StorageCode::ALL.iter().map(|code| code.as_str()).collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
