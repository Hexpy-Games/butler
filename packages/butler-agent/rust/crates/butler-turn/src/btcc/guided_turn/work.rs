use crate::btcc::authority::contracts::{
    AuthorityError, AuthorityExecutionInput, PrincipalAuthority,
};
use crate::btcc::work::{DurableWorkService, WorkContext, WorkTurnScope};
use crate::btcc::{BtccError, TurnRecord};

/// Failures preparing a guided turn.
#[derive(Debug, thiserror::Error)]
pub enum GuidedPreparationError {
    /// Durable work could not be read or validated.
    #[error(transparent)]
    Work(BtccError),
    /// An authority request could not be admitted.
    #[error(transparent)]
    Authority(AuthorityError),
    /// A guided contract was violated; the value is its wire code.
    #[error("{0}")]
    Contract(&'static str),
    /// Guided policy was invalid; the message says why.
    #[error("guided_policy_invalid: {0}")]
    Policy(String),
}

impl From<BtccError> for GuidedPreparationError {
    fn from(error: BtccError) -> Self {
        Self::Work(error)
    }
}
impl From<AuthorityError> for GuidedPreparationError {
    fn from(error: AuthorityError) -> Self {
        Self::Authority(error)
    }
}

/// The Work context a guided turn starts with.
pub struct GuidedWork {
    pub context: Option<WorkContext>,
    pub bound: bool,
}

/// The Work scope of a turn; ledger tracking scopes it to the project.
pub fn work_scope_for_turn(turn: &TurnRecord, tracking_mode: &str) -> WorkTurnScope {
    WorkTurnScope {
        turn_id: turn.turn_id.clone(),
        session_id: turn.session_id.clone(),
        project_ref: (tracking_mode == "ledger")
            .then(|| {
                turn.context
                    .get("projectRef")
                    .and_then(|value| value.as_str())
            })
            .flatten()
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    }
}

async fn load_initial_guided_work(
    service: &DurableWorkService,
    scope: &WorkTurnScope,
) -> Result<GuidedWork, GuidedPreparationError> {
    let mut context = service.load_context(scope.clone()).await?;
    if context.is_none() {
        // Legacy continuity is explicitly best effort; the second load is required.
        let _ = service.import_open_legacy_work(scope.clone()).await;
        context = service.load_context(scope.clone()).await?;
    }
    let Some(context) = context else {
        return Ok(GuidedWork {
            context: None,
            bound: false,
        });
    };
    let bound = service.bound_work_for_turn(scope.turn_id.clone()).await?;
    if bound.as_ref().map(|work| &work.work_id) != Some(&context.work.work_id) {
        return Ok(GuidedWork {
            context: Some(context),
            bound: false,
        });
    }
    // The source re-reads after proving the bound Work identity.
    drop(context);
    drop(bound);
    Ok(GuidedWork {
        context: service.load_context(scope.clone()).await?,
        bound: true,
    })
}

/// Loads (importing or binding as needed) the Work a guided turn continues.
pub async fn load_guided_turn_work(
    service: &DurableWorkService,
    authority: Option<&PrincipalAuthority>,
    turn: &TurnRecord,
    tracking_mode: &str,
    workspace_path: &str,
    owner_session_id: Option<&str>,
) -> Result<GuidedWork, GuidedPreparationError> {
    let scope = work_scope_for_turn(turn, tracking_mode);
    let request_ref = turn
        .context
        .get("authorityRequestRef")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());
    let client_message_id = turn
        .context
        .get("authorityClientMessageId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());
    let stored = match (request_ref, authority, client_message_id) {
        (Some(request_ref), Some(authority), Some(client_message_id)) => Some(
            authority
                .execution(AuthorityExecutionInput {
                    owner_session_id: owner_session_id.unwrap_or(&scope.session_id).to_owned(),
                    request_ref: request_ref.to_owned(),
                    source_session_id: Some(scope.session_id.clone()),
                    client_message_id: Some(client_message_id.to_owned()),
                    turn_id: scope.turn_id.clone(),
                })
                .await?,
        ),
        _ => None,
    };
    if request_ref.is_some() && stored.is_none() {
        return Err(GuidedPreparationError::Contract(
            "authority_context_missing",
        ));
    }
    // Questions and file observations resume the exact tool occurrence without a Work.
    let stored = stored.filter(|execution| requires_work(&execution.capability));
    if let Some(execution) = stored.as_ref() {
        if execution.source_session_id != scope.session_id
            || execution.source_turn_id != scope.turn_id
            || execution.workspace_path != workspace_path
        {
            return Err(GuidedPreparationError::Contract(
                "authority_request_identity_mismatch",
            ));
        }
        let bound = service.bound_work_for_turn(scope.turn_id.clone()).await?;
        if bound.as_ref().map(|work| &work.work_id) != Some(&execution.source_work_id) {
            return Err(GuidedPreparationError::Contract(
                "authority_source_work_unavailable",
            ));
        }
    }
    let initial = if tracking_mode == "none" {
        GuidedWork {
            context: None,
            bound: false,
        }
    } else {
        load_initial_guided_work(service, &scope).await?
    };
    if let Some(execution) = stored.as_ref()
        && (!initial.bound
            || initial
                .context
                .as_ref()
                .map(|context| &context.work.work_id)
                != Some(&execution.source_work_id))
    {
        return Err(GuidedPreparationError::Contract(
            "authority_source_work_unavailable",
        ));
    }
    Ok(initial)
}

fn requires_work(capability: &str) -> bool {
    !matches!(
        capability,
        "ask_user" | "read_file" | "list_files" | "grep_files"
    )
}
