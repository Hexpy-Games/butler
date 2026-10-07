//! App decisions use the existing principal store and inbound control queue.

use std::sync::Arc;

use serde_json::json;

use butler_core::json::JsonDocument;
use butler_gateway::gateway::{
    AppAuthorityDecision, AppAuthorityDecisionInput, AppAuthorityHandoff, AppAuthorityPage,
    ApplicationFuture, GatewayApplicationError, InboundQueue,
};
use butler_turn::btcc::{AuthorityDecisionInput, AuthorityError, PrincipalAuthority};

#[derive(Clone)]
pub(crate) struct AuthorityHandoff {
    authority: Arc<PrincipalAuthority>,
    queue: Arc<InboundQueue>,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    cache_provider: Option<std::sync::Weak<butler_models::models::ModelProvider>>,
}

impl AuthorityHandoff {
    pub(crate) fn new(
        authority: Arc<PrincipalAuthority>,
        queue: Arc<InboundQueue>,
        now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            authority,
            queue,
            now_iso,
            cache_provider: None,
        }
    }

    pub(crate) fn for_runtime(
        runtime: &crate::host::AgentRuntime,
        queue: Arc<InboundQueue>,
    ) -> Self {
        Self::new(
            runtime.authority.clone(),
            queue,
            Arc::new(|| {
                butler_models::models::ModelConfigurationClock::now_iso(
                    &crate::host::SystemIdentity,
                )
            }),
        )
        .with_cache_provider(&runtime.models.provider)
    }

    pub(crate) fn with_cache_provider(
        mut self,
        provider: &Arc<butler_models::models::ModelProvider>,
    ) -> Self {
        self.cache_provider = Some(Arc::downgrade(provider));
        self
    }

    async fn enqueue(&self, request_ref: &str) -> Result<(), GatewayApplicationError> {
        let source = self
            .authority
            .resume_source(request_ref.to_owned())
            .await
            .map_err(authority_error)?;
        let Some(source) = source else {
            return Ok(());
        };
        let destination = source.destination.as_ref();
        let peer = match destination {
            Some(destination) => serde_json::to_value(&destination.peer)
                .map_err(GatewayApplicationError::internal_from)?,
            None => json!({"kind":"dm","id":source.session_id}),
        };
        let transport = destination.map_or("app", |value| value.transport.as_str());
        let account_id = destination.map_or("local", |value| value.account_id.as_str());
        let requested_at = (self.now_iso)();
        let mut envelope = json!({
            "eventId":format!("app:resume:{request_ref}"),
            "transport":transport,
            "accountId":account_id,
            "peer":peer,
            "sender":{"id":"app-user","displayName":"Butler App"},
            "message":{
                "id":source.original_message_id,
                "text":source.original_message,
                "timestamp":requested_at,
            },
            "routingHints":{
                "sessionId":source.session_id,
                "turnId":source.turn_id,
                "canonicalEventId":source.original_event_id,
            },
            "control":{
                "kind":"resume_turn",
                "requestId":request_ref,
                "turnId":source.turn_id,
                "requestedAt":requested_at,
            },
            "raw":{"source":"app-server"},
        });
        if let Some(claim) = destination.and_then(|value| value.app_queue_claim_id.as_ref()) {
            envelope["routingHints"]["appQueueClaimId"] = json!(claim);
        }
        let document =
            JsonDocument::from_value(&envelope).map_err(GatewayApplicationError::internal_from)?;
        self.queue
            .enqueue_async(document)
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        Ok(())
    }
}

impl AppAuthorityHandoff for AuthorityHandoff {
    fn attention_sessions(&self, sessions: Vec<String>) -> ApplicationFuture<Vec<String>> {
        let authority = self.authority.clone();
        Box::pin(async move {
            authority
                .attention_owners(sessions)
                .await
                .map_err(authority_error)
        })
    }

    fn session_requests(
        &self,
        owner_session_id: String,
        turns: Vec<String>,
    ) -> ApplicationFuture<(Vec<serde_json::Value>, Vec<serde_json::Value>)> {
        let authority = self.authority.clone();
        Box::pin(async move {
            let (requests, answers) = authority
                .session_requests(owner_session_id, turns)
                .await
                .map_err(authority_error)?;
            Ok((public_values(requests)?, public_values(answers)?))
        })
    }

    fn close_self_session(
        &self,
        runtime_session_id: String,
        reason: String,
    ) -> ApplicationFuture<()> {
        if let Some(provider) = self
            .cache_provider
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
        {
            provider.stop_session_cache_wait(&runtime_session_id);
        }
        let authority = self.authority.clone();
        Box::pin(async move {
            authority
                .close_self_session(runtime_session_id, reason)
                .await
                .map(|_| ())
                .map_err(authority_error)
        })
    }

    fn list(&self, owner_session_id: String) -> ApplicationFuture<AppAuthorityPage> {
        let owner = self.authority.clone();
        Box::pin(async move {
            let requests = owner
                .list(owner_session_id.clone())
                .await
                .map_err(authority_error)?
                .iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(GatewayApplicationError::internal_from)?;
            let permissions = owner
                .list_permissions(owner_session_id)
                .await
                .map_err(authority_error)?
                .into_iter()
                .map(|item| {
                    json!({
                        "grant_ref":item.grant_ref,
                        "capability":item.capability,
                        "target":item.target,
                        "cwd":item.cwd,
                        "title":item.title,
                        "description":item.description,
                    })
                })
                .collect();
            Ok(AppAuthorityPage {
                requests,
                permissions,
            })
        })
    }

    fn list_all_permissions(
        &self,
    ) -> ApplicationFuture<Vec<butler_gateway::gateway::AppGrantView>> {
        let authority = self.authority.clone();
        Box::pin(async move {
            Ok(authority
                .list_all_permissions()
                .await
                .map_err(permission_error)?
                .into_iter()
                .map(|g| butler_gateway::gateway::AppGrantView {
                    grant_ref: g.grant_ref,
                    capability: g.capability,
                    target: g.target,
                    cwd: g.cwd,
                    scope: "conversation",
                    session_id: g.owner_session_id,
                    workspace_path: g.workspace_path,
                    created_at: g.created_at,
                    session_title: None,
                    project_id: None,
                    project_name: None,
                })
                .collect())
        })
    }
    fn revoke_permissions(
        &self,
        grants: Vec<butler_gateway::gateway::AppGrantRef>,
    ) -> ApplicationFuture<()> {
        let authority = self.authority.clone();
        Box::pin(async move {
            authority
                .revoke_permissions(
                    grants
                        .into_iter()
                        .map(|g| (g.session_id, g.grant_ref))
                        .collect(),
                )
                .await
                .map_err(permission_error)
        })
    }
    fn revoke(&self, owner_session_id: String, grant_ref: String) -> ApplicationFuture<()> {
        let owner = self.authority.clone();
        Box::pin(async move {
            owner
                .revoke_permission(owner_session_id, grant_ref)
                .await
                .map_err(authority_error)
        })
    }

    fn decide(&self, input: AppAuthorityDecisionInput) -> ApplicationFuture<AppAuthorityDecision> {
        let owner = self.clone();
        Box::pin(async move {
            let decision = owner
                .authority
                .decide(AuthorityDecisionInput {
                    owner_session_id: input.owner_session_id,
                    request_ref: input.request_ref,
                    source_session_id: None,
                    action: input.action,
                    allow_scope: input.allow_scope,
                    alternative_input: input.alternative_input,
                })
                .await
                .map_err(authority_error)?;
            if decision.question_followup.is_none() {
                owner.enqueue(&decision.request_ref).await?;
            }
            Ok(AppAuthorityDecision {
                request_ref: decision.request_ref,
                decision: decision.decision.as_str().into(),
                admitted: true,
                question_followup: decision.question_followup,
            })
        })
    }

    fn retry_decided(&self) -> ApplicationFuture<Vec<(String, String, String)>> {
        let owner = self.clone();
        Box::pin(async move {
            let mut followups = Vec::new();
            for decision in owner
                .authority
                .list_decided()
                .await
                .map_err(authority_error)?
            {
                if let Some(input) = decision.question_followup {
                    followups.push((decision.owner_session_id, decision.request_ref, input));
                } else {
                    owner.enqueue(&decision.request_ref).await?;
                }
            }
            Ok(followups)
        })
    }
    fn settle_question_followup(&self, request_ref: String) -> ApplicationFuture<()> {
        let authority = self.authority.clone();
        Box::pin(async move {
            authority
                .settle_question_followup(request_ref)
                .await
                .map_err(authority_error)
        })
    }
}

fn public_values<T: serde::Serialize>(
    values: Vec<T>,
) -> Result<Vec<serde_json::Value>, GatewayApplicationError> {
    values
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(GatewayApplicationError::internal_from)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn authority_error(error: AuthorityError) -> GatewayApplicationError {
    let (status, public_code, message) = match error.code() {
        "authority_modify_input_missing" | "authority_modify_input_too_large" => {
            (400, error.code(), "Modify instruction is invalid.")
        }
        "question_answer_invalid" => (
            400,
            "question_answer_invalid",
            "Choose an answer and try again.",
        ),
        "authority_modify_identity_mismatch" => (
            409,
            error.code(),
            "Modify instruction conflicts with the stored decision.",
        ),
        "authority_decision_conflict" => (
            409,
            error.code(),
            "The authority request already has a different decision.",
        ),
        "authority_request_not_found" => (
            404,
            "authority_request_not_found",
            "Authority request not found.",
        ),
        _ => return GatewayApplicationError::internal(),
    };
    GatewayApplicationError::Public {
        status,
        code: public_code.into(),
        message: message.into(),
        source: None,
    }
}

fn permission_error(error: AuthorityError) -> GatewayApplicationError {
    let (status, code, message) = if error.code() == "authority_permission_not_found" {
        (404, "authority_permission_not_found", "Approval not found.")
    } else {
        (503, "authority_unavailable", "Approvals are unavailable.")
    };
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: Some(std::sync::Arc::new(error)),
    }
}
