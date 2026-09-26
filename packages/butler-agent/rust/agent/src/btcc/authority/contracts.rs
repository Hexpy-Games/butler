use std::borrow::Cow;
use std::sync::Arc;

use serde_json::Value;

use crate::btcc::BtccSource;
use crate::btcc::storage::BtccStorage;
use crate::locale::LocaleCollation;

/// Failures of authority requests (permission, schedule and modify decisions).
///
/// `Display` renders `code: message`; for policy refusals the message is the code.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum AuthorityError {
    /// A policy check refused or could not match the request (not found,
    /// corrupt record, identity mismatch, conflicting decision).
    #[error("{code}: {code}")]
    Policy {
        code: Cow<'static, str>,
        #[source]
        source: Option<BtccSource>,
    },
    /// Reading or writing authority records failed in storage.
    #[error("{code}: {message}")]
    Storage {
        code: Cow<'static, str>,
        message: String,
        #[source]
        source: Option<BtccSource>,
    },
}

impl AuthorityError {
    pub(crate) fn policy(code: impl Into<Cow<'static, str>>) -> Self {
        Self::Policy {
            code: code.into(),
            source: None,
        }
    }

    pub(crate) fn storage(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::Storage {
            code: code.into(),
            message: message.into(),
            source: None,
        }
    }

    /// Records `source` as the cause when none is recorded yet.
    #[must_use]
    pub(crate) fn with_source(self, cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        match self {
            Self::Policy { code, source: None } => Self::Policy {
                code,
                source: Some(Arc::new(cause)),
            },
            Self::Storage {
                code,
                message,
                source: None,
            } => Self::Storage {
                code,
                message,
                source: Some(Arc::new(cause)),
            },
            other => other,
        }
    }

    pub(crate) fn code(&self) -> &str {
        match self {
            Self::Policy { code, .. } | Self::Storage { code, .. } => code,
        }
    }

    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Policy { code, .. } => code,
            Self::Storage { message, .. } => message,
        }
    }
}

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for AuthorityError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for AuthorityError {}

impl From<crate::btcc::StorageError> for AuthorityError {
    fn from(error: crate::btcc::StorageError) -> Self {
        Self::Storage {
            code: error.code().into(),
            message: error.message(),
            source: Some(Arc::new(error)),
        }
    }
}
pub(crate) type AuthorityResult<T> = Result<T, AuthorityError>;

#[derive(Clone, Debug)]
pub(crate) struct AuthorityAdmissionInput {
    pub(crate) public_action_title: Option<String>,
    pub(crate) owner_session_id: String,
    pub(crate) source_session_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) operation_occurrence_id: Option<String>,
    pub(crate) source_work_id: String,
    pub(crate) workspace_path: String,
    pub(crate) plan_revision_id: String,
    pub(crate) action_key: String,
    pub(crate) authority_generation: i64,
    pub(crate) capability: String,
    pub(crate) target: String,
    pub(crate) model_ref: String,
    pub(crate) reasoning_effort: String,
    pub(crate) category: Option<String>,
    pub(crate) normalized_input: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AuthorityAdmissionResult {
    Granted,
    Pending {
        request_ref: String,
        projection: Value,
    },
    Allowed {
        request_ref: String,
        source_work_id: String,
        normalized_target: String,
        normalized_input: Value,
    },
    Denied {
        request_ref: String,
        denial_text: &'static str,
    },
    Modified {
        request_ref: String,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct AuthorityDecisionInput {
    pub(crate) owner_session_id: String,
    pub(crate) request_ref: String,
    pub(crate) source_session_id: Option<String>,
    pub(crate) action: String,
    pub(crate) allow_scope: Option<String>,
    pub(crate) alternative_input: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthorityDecisionResult {
    pub(crate) request_ref: String,
    pub(crate) source_session_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) source_work_id: String,
    pub(crate) schedule_client_message_id: String,
    pub(crate) schedule_input_text: String,
    pub(crate) model_ref: String,
    pub(crate) reasoning_effort: String,
    pub(crate) decision: String,
}
#[derive(Clone, Debug)]
pub(crate) struct AuthorityExecutionInput {
    pub(crate) owner_session_id: String,
    pub(crate) request_ref: String,
    pub(crate) source_session_id: Option<String>,
    pub(crate) client_message_id: Option<String>,
    pub(crate) turn_id: String,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AuthorityStoredExecution {
    pub(crate) request_ref: String,
    pub(crate) source_session_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) source_call_id: Option<String>,
    pub(crate) source_work_id: String,
    pub(crate) workspace_path: String,
    pub(crate) plan_revision_id: String,
    pub(crate) action_key: String,
    pub(crate) authority_generation: i64,
    pub(crate) capability: String,
    pub(crate) normalized_target: String,
    pub(crate) category: String,
    pub(crate) normalized_input: Value,
    pub(crate) decision: String,
    pub(crate) alternative_input: Option<String>,
    pub(crate) outcome: String,
    pub(crate) outcome_receipt: Option<Value>,
}
#[derive(Clone, Debug)]
pub(crate) struct AuthorityOutcomeInput {
    pub(crate) request_ref: String,
    pub(crate) owner_session_id: String,
    pub(crate) source_work_id: String,
    pub(crate) status: String,
    pub(crate) receipt: Option<Value>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthorityOperationalCloseResult {
    pub(crate) scope: &'static str,
    pub(crate) reason: String,
    pub(crate) closed_count: usize,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AuthorityResumeSource {
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) original_event_id: String,
    pub(crate) original_message_id: String,
    pub(crate) original_message: String,
    pub(crate) destination: Option<Value>,
}
#[derive(Clone, Debug)]
pub(crate) struct AuthorityRecord {
    pub(crate) request_id: String,
    pub(crate) request_ref: String,
    pub(crate) identity_sha256: String,
    pub(crate) owner_session_id: String,
    pub(crate) source_session_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) source_call_id: Option<String>,
    pub(crate) source_work_id: String,
    pub(crate) workspace_path: String,
    pub(crate) plan_revision_id: String,
    pub(crate) action_key: String,
    pub(crate) authority_generation: i64,
    pub(crate) capability: String,
    pub(crate) normalized_target: String,
    pub(crate) normalized_input_json: String,
    pub(crate) model_ref: String,
    pub(crate) reasoning_effort: String,
    pub(crate) category: String,
    pub(crate) reason: String,
    pub(crate) executable: String,
    pub(crate) command_count: i64,
    pub(crate) decision: String,
    pub(crate) allow_scope: String,
    pub(crate) schedule_client_message_id: String,
    pub(crate) schedule_input_text: String,
    pub(crate) private_alternative_input: Option<String>,
    pub(crate) outcome: String,
    pub(crate) outcome_receipt_json: Option<String>,
    pub(crate) close_reason: Option<String>,
    pub(crate) close_scope: Option<String>,
    pub(crate) closed_at: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ConversationPermission {
    pub(crate) grant_ref: String,
    pub(crate) owner_session_id: String,
    pub(crate) workspace_path: String,
    pub(crate) scope_key: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) created_at: String,
}
#[derive(Clone, Debug)]
pub(crate) struct DecisionWrite {
    pub(crate) request_ref: String,
    pub(crate) owner_session_id: String,
    pub(crate) source_session_id: String,
    pub(crate) action: String,
    pub(crate) permission: Option<ConversationPermission>,
    pub(crate) alternative_input: Option<String>,
    pub(crate) now: String,
}
#[derive(Clone, Debug)]
pub(crate) struct OutcomeWrite {
    pub(crate) request_ref: String,
    pub(crate) source_work_id: String,
    pub(crate) status: String,
    pub(crate) receipt_json: Option<String>,
    pub(crate) now: String,
}

pub(crate) trait AuthorityRepository {
    fn retains_approval_claim(&mut self, turn_id: &str) -> AuthorityResult<bool>;
    fn has_permission(&mut self, grant_ref: &str) -> AuthorityResult<bool>;
    fn list_permissions(&mut self, owner: &str) -> AuthorityResult<Vec<ConversationPermission>>;
    fn revoke_permission(&mut self, owner: &str, grant_ref: &str, now: &str)
    -> AuthorityResult<()>;
    fn resume_source(
        &mut self,
        request_ref: &str,
    ) -> AuthorityResult<Option<AuthorityResumeSource>>;
    fn waiting_source_sessions(&mut self) -> AuthorityResult<Vec<String>>;
    fn find_identity(&mut self, sha: &str) -> AuthorityResult<Option<AuthorityRecord>>;
    fn find_slot(
        &mut self,
        record: &AuthorityAdmissionInput,
        generation: i64,
    ) -> AuthorityResult<Option<AuthorityRecord>>;
    fn insert(&mut self, record: &AuthorityRecord) -> AuthorityResult<()>;
    fn find_ref(&mut self, request_ref: &str) -> AuthorityResult<Option<AuthorityRecord>>;
    fn list_pending(&mut self, owner: &str) -> AuthorityResult<Vec<AuthorityRecord>>;
    fn list_decided(&mut self) -> AuthorityResult<Vec<AuthorityRecord>>;
    fn source_work_eligible(&mut self, session: &str, work: &str) -> AuthorityResult<bool>;
    fn decide(&mut self, write: DecisionWrite) -> AuthorityResult<Option<AuthorityRecord>>;
    fn record_outcome(&mut self, write: OutcomeWrite) -> AuthorityResult<()>;
    fn close_self(&mut self, session: &str, reason: &str, now: &str) -> AuthorityResult<usize>;
}

#[derive(Clone)]
pub(crate) struct NativePrincipalAuthority {
    pub(super) storage: BtccStorage,
    pub(super) collation: Arc<LocaleCollation>,
    pub(super) clock: Arc<dyn Fn() -> String + Send + Sync>,
    pub(super) uuid: Arc<dyn Fn() -> String + Send + Sync>,
}
