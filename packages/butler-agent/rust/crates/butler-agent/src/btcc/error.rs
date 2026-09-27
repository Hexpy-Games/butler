//! The error carried by BTCC ports, turns and the runtime facade.

use std::borrow::Cow;
use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of failures BTCC itself detects.
    pub(crate) enum BtccCode {
        ActiveStewardRelationAmbiguous = "active_steward_relation_ambiguous",
        ActiveStewardRelationNotFound = "active_steward_relation_not_found",
        AdmittedModelInvalid = "admitted_model_invalid",
        AdmittedModelMissing = "admitted_model_missing",
        AdmittedReasoningInvalid = "admitted_reasoning_invalid",
        AuthorityContinuationCursorInvalid = "authority_continuation_cursor_invalid",
        AuthorityDecisionMissing = "authority_decision_missing",
        AuthorityModifyInputMissing = "authority_modify_input_missing",
        AuthoritySourceCallMissing = "authority_source_call_missing",
        BoundedContinuationSerializationFailed = "bounded_continuation_serialization_failed",
        BtccAgentLoopFinalCandidateObservationMissing = "btcc_agent_loop_final_candidate_observation_missing",
        BtccClosing = "btcc_closing",
        BtccJsonError = "btcc_json_error",
        BtccStopGenerationExhausted = "btcc_stop_generation_exhausted",
        BtccTaskFailed = "btcc_task_failed",
        ButlerEolContextAssemblyInvalid = "butler_eol_context_assembly_invalid",
        Cancelled = "cancelled",
        CanonicalJson = "canonical_json",
        CommandInvalid = "command_invalid",
        ContextInvalid = "context_invalid",
        ContextProjectBindingMissing = "context_project_binding_missing",
        ContextProjectionInvalid = "context_projection_invalid",
        ContextScopeInvalid = "context_scope_invalid",
        ContinuationBudgetJson = "continuation_budget_json",
        ConversationOutcomeInvalid = "conversation_outcome_invalid",
        DelegationAllowedEffectsRequired = "delegation_allowed_effects_required",
        DelegationMutationScopeRequired = "delegation_mutation_scope_required",
        DelegationReviewedPlanRequired = "delegation_reviewed_plan_required",
        DurableWorkOpenMissing = "durable_work_open_missing",
        DurableWorkPlanMissing = "durable_work_plan_missing",
        DurableWorkPolicy = "durable_work_policy",
        DurableWorkSerializationFailed = "durable_work_serialization_failed",
        DurableWorkStageMissing = "durable_work_stage_missing",
        DurableWorkTerminalRelation = "durable_work_terminal_relation",
        DurableWorkValidation = "durable_work_validation",
        GuidedCatalogInvalid = "guided_catalog_invalid",
        GuidedToolResultJson = "guided_tool_result_json",
        InvalidAdmittedModelSelection = "invalid_admitted_model_selection",
        InvalidAuthorityContinuation = "invalid_authority_continuation",
        InvalidButlerContext = "invalid_butler_context",
        InvalidContinuationBudget = "invalid_continuation_budget",
        InvalidContinuationBudgetDigest = "invalid_continuation_budget_digest",
        InvalidContinuationBudgetDuplicateRound = "invalid_continuation_budget_duplicate_round",
        InvalidContinuationBudgetEvent = "invalid_continuation_budget_event",
        InvalidContinuationBudgetIdentity = "invalid_continuation_budget_identity",
        InvalidContinuationBudgetInteger = "invalid_continuation_budget_integer",
        InvalidContinuationBudgetOutputBound = "invalid_continuation_budget_output_bound",
        InvalidContinuationBudgetPromptBound = "invalid_continuation_budget_prompt_bound",
        InvalidContinuationBudgetTerminal = "invalid_continuation_budget_terminal",
        InvalidContinuationBudgetText = "invalid_continuation_budget_text",
        InvalidContinuationBudgetTime = "invalid_continuation_budget_time",
        InvalidDeliveryState = "invalid_delivery_state",
        InvalidTurnContinuationLimit = "invalid_turn_continuation_limit",
        InvalidWorkStageTransition = "invalid_work_stage_transition",
        MissingCanonicalMessage = "missing_canonical_message",
        MissingFinalPayload = "missing_final_payload",
        ModelHistoryInvalid = "model_history_invalid",
        ModelMetadataMissing = "model_metadata_missing",
        ModelNumberInvalid = "model_number_invalid",
        ModelResponseInvalid = "model_response_invalid",
        ModelRoundOutputSerializationFailed = "model_round_output_serialization_failed",
        ModelRoundOutputTooLarge = "model_round_output_too_large",
        ModelRouteDurabilityFailure = "model_route_durability_failure",
        ModelRouteExhausted = "model_route_exhausted",
        ModelRouteInvalid = "model_route_invalid",
        OperationResultArgumentCoercionFailed = "operation_result_argument_coercion_failed",
        OperationResultDeliveryAdmissionFailed = "operation_result_delivery_admission_failed",
        OperationResultDeliveryInFlightMismatch = "operation_result_delivery_in_flight_mismatch",
        OperationResultExactReadDependencyMissing = "operation_result_exact_read_dependency_missing",
        OperationResultExactReadUnavailable = "operation_result_exact_read_unavailable",
        OperationResultHashInvalid = "operation_result_hash_invalid",
        OperationResultLengthInvalid = "operation_result_length_invalid",
        OperationResultMessageMeasurementMissing = "operation_result_message_measurement_missing",
        OperationResultModelMeasurementUnexpected = "operation_result_model_measurement_unexpected",
        OperationResultOffsetInvalid = "operation_result_offset_invalid",
        OperationResultReferenceInvalid = "operation_result_reference_invalid",
        OperationResultReferenceUnavailable = "operation_result_reference_unavailable",
        OperationResultRevisionInvalid = "operation_result_revision_invalid",
        OperationResultRevisionMismatch = "operation_result_revision_mismatch",
        OperationResultRouteAcceptanceMissing = "operation_result_route_acceptance_missing",
        OperationResultSerializationFailed = "operation_result_serialization_failed",
        OperationResultSourceInvalid = "operation_result_source_invalid",
        OperationResultToolNameInvalid = "operation_result_tool_name_invalid",
        OperationResultWorkIdInvalid = "operation_result_work_id_invalid",
        ParentAppBindingRequired = "parent_app_binding_required",
        ParentButlerSessionRequired = "parent_butler_session_required",
        ParentStewardContextRequired = "parent_steward_context_required",
        ParentStewardSessionRequired = "parent_steward_session_required",
        PhaseContinuityProjectionRebaseIdentityInvalid = "phase_continuity_projection_rebase_identity_invalid",
        ProjectWorkLegacySourceChanged = "project_work_legacy_source_changed",
        RoundToolSurfaceContinuationInvalid = "round_tool_surface_continuation_invalid",
        SessionBindingMissing = "session_binding_missing",
        SessionBindingRoleMismatch = "session_binding_role_mismatch",
        SqliteContention = "sqlite_contention",
        StewardDelegationPlanModeRequired = "steward_delegation_plan_mode_required",
        StewardDirectionIdentityConflict = "steward_direction_identity_conflict",
        StewardDirectionInstructionRequired = "steward_direction_instruction_required",
        StewardDirectionInstructionTooLong = "steward_direction_instruction_too_long",
        StewardFollowupAuthorityMismatch = "steward_followup_authority_mismatch",
        StewardProjectBindingMissing = "steward_project_binding_missing",
        StewardRelationNotActive = "steward_relation_not_active",
        StewardRelationNotFound = "steward_relation_not_found",
        StewardRelationNotRecoverable = "steward_relation_not_recoverable",
        SubsessionAccessModeInvalid = "subsession_access_mode_invalid",
        SubsessionChildBindingMismatch = "subsession_child_binding_mismatch",
        SubsessionChildBindingMissing = "subsession_child_binding_missing",
        SubsessionChildRoleInvalid = "subsession_child_role_invalid",
        SubsessionContextAssemblyInvalid = "subsession_context_assembly_invalid",
        SubsessionContextInvalid = "subsession_context_invalid",
        SubsessionDirectionChildBindingMissing = "subsession_direction_child_binding_missing",
        SubsessionDirectionRelationMissing = "subsession_direction_relation_missing",
        SubsessionDispatchIntentInvalid = "subsession_dispatch_intent_invalid",
        SubsessionEffectNotAllowed = "subsession_effect_not_allowed",
        SubsessionIdentityInvalid = "subsession_identity_invalid",
        SubsessionMutationScopeInvalid = "subsession_mutation_scope_invalid",
        SubsessionMutationScopeWildcardNotAllowed = "subsession_mutation_scope_wildcard_not_allowed",
        SubsessionOutboxInvalid = "subsession_outbox_invalid",
        SubsessionParentBindingMissing = "subsession_parent_binding_missing",
        SubsessionPersistFailed = "subsession_persist_failed",
        SubsessionProjectionInvalid = "subsession_projection_invalid",
        SubsessionReadOnlySurfaceIncomplete = "subsession_read_only_surface_incomplete",
        SubsessionRelationMissing = "subsession_relation_missing",
        SubsessionResultTurnContextInvalid = "subsession_result_turn_context_invalid",
        SubsessionRootWorkIdentityMismatch = "subsession_root_work_identity_mismatch",
        SuspensionNotPersisted = "suspension_not_persisted",
        ToolJournalJsonInvalid = "tool_journal_json_invalid",
        ToolResultJson = "tool_result_json",
        TurnCancelled = "turn_cancelled",
        TurnContinuationBudgetExhausted = "turn_continuation_budget_exhausted",
        TurnContinuationDependencyMissing = "turn_continuation_dependency_missing",
        TurnExecutionControlsIntegrityMismatch = "turn_execution_controls_integrity_mismatch",
        TurnExecutionControlsInvalid = "turn_execution_controls_invalid",
        TurnFenced = "turn_fenced",
        TurnReplayConflict = "turn_replay_conflict",
        TurnReplayModelInvalid = "turn_replay_model_invalid",
        UnsafeTurnContinuationLimit = "unsafe_turn_continuation_limit",
        WakeAuthorizationDenied = "wake_authorization_denied",
        WorkTransitionGuardUnmet = "work_transition_guard_unmet",
        WorkerDelegationPlanModeRequired = "worker_delegation_plan_mode_required",
        WorkerPlanActionDependencyIncomplete = "worker_plan_action_dependency_incomplete",
        WorkerPlanActionMissing = "worker_plan_action_missing",
        WorkerPlanActionNotExecutable = "worker_plan_action_not_executable",
    }
}

/// A shareable underlying error (turn results are cloned to every waiter).
pub(crate) type BtccSource = Arc<dyn Error + Send + Sync>;

/// A BTCC failure.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`. Codes BTCC detects itself are a closed
/// `BtccCode` set; codes relayed through a port keep the reporter's own text,
/// because they also come from persisted failure records (provider, effect
/// and authority failures) whose codes are stored as strings.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum BtccError {
    /// A BTCC check failed: invalid transition, missing record, conflicting
    /// claim, closed runtime. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected { code: BtccCode, message: String },
    /// A lower-level operation BTCC performed failed; `code` names what BTCC
    /// was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: BtccCode,
        message: String,
        #[source]
        source: BtccSource,
    },
    /// A failure reported through a BTCC port by another domain (storage,
    /// Conversation, workspace, host adapters) or read back from a persisted
    /// failure record. `code` and `message` are the reporter's own; `source`
    /// is the reporter's error when it was available.
    #[error("{code}: {message}")]
    Relayed {
        code: Cow<'static, str>,
        message: String,
        #[source]
        source: Option<BtccSource>,
    },
}

impl BtccError {
    /// A failure BTCC detected itself.
    pub(crate) fn detected(code: BtccCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
        }
    }

    /// A failure reported by another domain or a persisted failure record.
    pub(crate) fn relayed(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::Relayed {
            code: code.into(),
            message: message.into(),
            source: None,
        }
    }

    /// Relays another domain's error, keeping it as the source.
    pub(crate) fn relay(
        code: impl Into<Cow<'static, str>>,
        message: impl Into<String>,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self::Relayed {
            code: code.into(),
            message: message.into(),
            source: Some(Arc::new(source)),
        }
    }

    /// Records `source` as the cause, keeping the code and message. An error
    /// that already carries a cause is returned as is.
    #[must_use]
    pub(crate) fn with_source(self, source: impl Error + Send + Sync + 'static) -> Self {
        match self {
            Self::Detected { code, message } => Self::Failed {
                code,
                message,
                source: Arc::new(source),
            },
            Self::Relayed {
                code,
                message,
                source: None,
            } => Self::Relayed {
                code,
                message,
                source: Some(Arc::new(source)),
            },
            other => other,
        }
    }

    /// The persisted wire code.
    pub(crate) fn code(&self) -> &str {
        match self {
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
            Self::Relayed { code, .. } => code,
        }
    }

    /// The user-facing message.
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Detected { message, .. }
            | Self::Failed { message, .. }
            | Self::Relayed { message, .. } => message,
        }
    }
}

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for BtccError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for BtccError {}

impl From<crate::btcc::StorageError> for BtccError {
    fn from(error: crate::btcc::StorageError) -> Self {
        Self::relay(error.code(), error.message(), error)
    }
}

impl From<crate::btcc::AuthorityError> for BtccError {
    fn from(error: crate::btcc::AuthorityError) -> Self {
        Self::relay(error.code().to_owned(), error.message().to_owned(), error)
    }
}

impl From<crate::btcc::EffectFailure> for BtccError {
    fn from(error: crate::btcc::EffectFailure) -> Self {
        Self::relay(error.code().to_owned(), error.message().to_owned(), error)
    }
}

impl From<crate::workspace::CommandError> for BtccError {
    fn from(error: crate::workspace::CommandError) -> Self {
        Self::relay(error.code(), error.message(), error)
    }
}

impl From<crate::workspace::WorkspaceError> for BtccError {
    fn from(error: crate::workspace::WorkspaceError) -> Self {
        Self::relay(error.code(), error.message(), error)
    }
}

impl From<crate::conversation::ConversationError> for BtccError {
    fn from(error: crate::conversation::ConversationError) -> Self {
        Self::relay(error.code(), error.message(), error)
    }
}

#[cfg(test)]
mod tests {
    use super::BtccCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = BtccCode::ALL.iter().map(|code| code.as_str()).collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
