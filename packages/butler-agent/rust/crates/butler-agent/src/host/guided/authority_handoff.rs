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
        }
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
            .enqueue_idempotent(document)
            .map_err(GatewayApplicationError::internal_from)?;
        Ok(())
    }
}

impl AppAuthorityHandoff for AuthorityHandoff {
    fn close_self_session(
        &self,
        runtime_session_id: String,
        reason: String,
    ) -> ApplicationFuture<()> {
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
            owner.enqueue(&decision.request_ref).await?;
            Ok(AppAuthorityDecision {
                request_ref: decision.request_ref,
                decision: decision.decision.as_str().into(),
                admitted: true,
            })
        })
    }

    fn retry_decided(&self) -> ApplicationFuture<()> {
        let owner = self.clone();
        Box::pin(async move {
            for decision in owner
                .authority
                .list_decided()
                .await
                .map_err(authority_error)?
            {
                owner.enqueue(&decision.request_ref).await?;
            }
            Ok(())
        })
    }
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
