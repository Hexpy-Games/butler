//! Claimed queue admission and native handoff retain pending input on shutdown.

use super::*;
use super::{send::ResolvedAppAdmission, service::accept_turn};
use butler_turn::btcc::ExecutionControls;

impl AppApplication {
    pub(super) async fn start_turn(
        &self,
        claim: QueueClaim,
        prepared: ResolvedAppAdmission,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        use tracing::Instrument;
        let queued = claim.queued_message_id.clone();
        let (context, queued_at) = self
            .storage
            .read(move |db| {
                db.query_row(
                    "SELECT trace_context_json, created_at FROM session_queued_messages WHERE id=?1",
                    [&queued],
                    |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        let mut context: butler_log::TraceContext = context
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(butler_log::TraceContext::current);
        context.chat_id = Some(claim.chat_id.clone());
        let queue = context.root_span("turn.dequeue");
        queue.record(
            "started_at",
            context.enqueued_at.as_deref().unwrap_or(&queued_at),
        );
        drop(queue);
        async {
            let result = self.start_turn_traced(claim, prepared).await;
            if let Err(error) = &result {
                tracing::error!(%error, "Turn dispatch failed");
            }
            result
        }
        .instrument(context.root_span("turn.dispatch"))
        .await
    }

    async fn start_turn_traced(
        &self,
        claim: QueueClaim,
        prepared: ResolvedAppAdmission,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        self.ensure_dispatch_open(&claim).await?;
        let queue_replay = self.claimed_dispatch(&claim).await?.is_some();
        let (message_id, turn_id) = match self.admit_claimed_turn(&claim, prepared).await {
            Ok(linked) => linked,
            Err(error) => return Err(self.dispatch_error(&claim, error).await?),
        };
        tracing::Span::current()
            .record("turn_id", &turn_id)
            .record("message_id", &message_id);
        #[cfg(feature = "e2e-fixtures")]
        self.hold_queue_admission(&message_id).await?;
        self.ensure_dispatch_open(&claim).await?;
        self.enqueue_claimed_turn(&claim, &turn_id, queue_replay)
            .await?;
        self.dispatch_result(&claim.chat_id, &message_id, &turn_id)
            .await
    }

    async fn admit_claimed_turn(
        &self,
        claim: &QueueClaim,
        prepared: ResolvedAppAdmission,
    ) -> Result<(String, String), GatewayApplicationError> {
        let linked = self.claimed_dispatch(claim).await?;
        let (message_id, turn_id) = if let Some(linked) = linked {
            (linked.message_id, linked.turn_id)
        } else {
            let turn_id = format!("turn-{}", self.dependencies.identity_clock.new_uuid());
            let message_id = self.claimed_client_message_id(claim).await?;
            let now = self.dependencies.identity_clock.now_iso();
            let controls =
                ExecutionControls::create(&turn_id, &claim.chat_id, prepared.controls, &now)
                    .map_err(|source| {
                        public(
                            500,
                            "turn_execution_controls_invalid",
                            "Turn controls are unavailable.",
                        )
                        .with_source(source)
                    })?;
            controls.verify().map_err(|source| {
                public(
                    500,
                    "turn_execution_controls_invalid",
                    "Turn controls are unavailable.",
                )
                .with_source(source)
            })?;
            let controls_value = controls.as_json().clone();
            let claim_db = claim.clone();
            let turn_db = turn_id.clone();
            let message_db = message_id.clone();
            let now_db = now.clone();
            let text = prepared.text.clone();
            let controls_json = stringify(&controls_value)?;
            self.storage
                .execute(move |connection| {
                    accept_turn(
                        connection,
                        &claim_db,
                        &turn_db,
                        &message_db,
                        &text,
                        &controls_json,
                        &now_db,
                    )
                })
                .await
                .map_err(app_error)?;
            self.publish_acceptance(&claim.chat_id, &message_id, &turn_id)
                .await?;
            (message_id, turn_id)
        };
        Ok((message_id, turn_id))
    }

    async fn enqueue_claimed_turn(
        &self,
        claim: &QueueClaim,
        turn_id: &str,
        queue_replay: bool,
    ) -> Result<(), GatewayApplicationError> {
        let (native, waiting_hook_context) = match self.prepare_claimed_native(claim).await {
            Ok(prepared) => prepared,
            Err(error) => return Err(self.dispatch_error(claim, error).await?),
        };
        self.ensure_dispatch_open(claim).await?;
        let receipt = match self
            .dependencies
            .native_ingress
            .enqueue(native.clone())
            .await
        {
            Ok(receipt) => receipt,
            Err(error) => {
                if self.fence_claim(claim, turn_id).await? {
                    match self.dependencies.native_ingress.find(native).await? {
                        Some(receipt) => receipt,
                        None => {
                            let error = if matches!(&error, GatewayApplicationError::Public { code, .. } if code == "service_stopping")
                            {
                                error
                            } else {
                                public(
                                    503,
                                    "app_transport_enqueue_failed",
                                    "The message could not be queued.",
                                )
                                .with_source(error)
                            };
                            return Err(self.dispatch_error(claim, error).await?);
                        }
                    }
                } else {
                    return Err(public(
                        409,
                        "queued_message_claim_lost",
                        "The queued message claim was lost.",
                    ));
                }
            }
        };
        if let Some(read) = waiting_hook_context {
            self.settle_hook_context(claim, read).await;
        }
        if !queue_replay {
            self.publish_native_queued(claim, turn_id, &receipt).await?;
        }
        Ok(())
    }

    /// The turn is accepted and already carries the text; failing to record that
    /// only means a later turn reads the waiting text again.
    async fn settle_hook_context(&self, claim: &QueueClaim, read: String) {
        let (chat, queued) = (claim.chat_id.clone(), claim.queued_message_id.clone());
        let settled = self
            .storage
            .execute(move |db| super::hook_context::settle(db, &chat, &queued, &read))
            .await;
        if let Err(error) = settled {
            butler_core::diagnostic!("warning: SessionStart hook output not settled: {error}");
        }
    }

    async fn dispatch_result(
        &self,
        chat_id: &str,
        message_id: &str,
        turn_id: &str,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        let messages = self.message_page(chat_id.to_owned(), 0.0, 200).await?;
        let chat = chat_id.to_owned();
        let turn = turn_id.to_owned();
        let turn = self
            .storage
            .inspect(move |db| {
                Ok(read_model::exact_turn(db, &turn)?.filter(|row| row.chat_id == chat))
            })
            .await
            .map_err(app_error)?;
        Ok(MessageSendResult {
            accepted: messages
                .messages
                .into_iter()
                .find(|item| item.id == message_id),
            queued: None,
            reply: None,
            replies: Vec::new(),
            turn,
            next_cursor: butler_core::json::saturating_u64(messages.next_cursor),
        })
    }

    async fn ensure_dispatch_open(
        &self,
        claim: &QueueClaim,
    ) -> Result<(), GatewayApplicationError> {
        if self.queue_wake.is_stopping() {
            self.park_dispatch(claim).await?;
            return Err(public(
                503,
                "service_stopping",
                "Service is stopping. Try again.",
            ));
        }
        Ok(())
    }

    async fn dispatch_error(
        &self,
        claim: &QueueClaim,
        error: GatewayApplicationError,
    ) -> Result<GatewayApplicationError, GatewayApplicationError> {
        if self.queue_wake.is_stopping()
            || matches!(&error, GatewayApplicationError::Public { code, .. } if code == "service_stopping")
        {
            self.park_dispatch(claim).await?;
            return Ok(public(
                503,
                "service_stopping",
                "Service is stopping. Try again.",
            ));
        }
        let code: &str = match &error {
            GatewayApplicationError::Public { code, .. } => code,
            GatewayApplicationError::Internal { .. } => "queued_message_dispatch_failed",
        };
        self.fail_dispatch(claim, code).await?;
        Ok(error)
    }
}

#[cfg(feature = "e2e-fixtures")]
impl AppApplication {
    /// E2E barrier after durable Turn creation, before native enqueue. It
    /// replaces CPU-dependent SQLite work with the exact shutdown boundary.
    async fn hold_queue_admission(&self, message_id: &str) -> Result<(), GatewayApplicationError> {
        if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
            || std::env::var("BUTLER_E2E_HOLD_QUEUE_MESSAGE").as_deref() != Ok(message_id)
        {
            return Ok(());
        }
        tokio::fs::write(self.butler_data.join("e2e-queue-admission-held"), b"held")
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        self.queue_wake.stopped().await;
        Ok(())
    }
}
