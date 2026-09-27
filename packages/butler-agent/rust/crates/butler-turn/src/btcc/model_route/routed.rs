use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::btcc::BtccError;
use crate::btcc::agent_loop::{
    ModelRoundError, ModelRoundPort, ModelRoundRequest, ModelRoundResult,
};

use super::contracts::{
    AttemptHistory, ContextSizing, ContextSizingRequest, FailureDisposition, FailureRecord,
    ModelRouteRetryConfig, RouteCandidate, RouteState,
};
use super::execution::ViewState;
use super::support::*;
use super::{failure, hooks::RouteHooks, projection};
use crate::btcc::BtccCode;
use crate::btcc::{AttemptFailure, ModelRouteEventKind, RouteEventStatus};

pub(super) struct RoutedRound<'a> {
    pub(super) base: &'a dyn ModelRoundPort,
    pub(super) turn_id: &'a str,
    pub(super) route: AsyncMutex<RouteState>,
    pub(super) hooks: RouteHooks,
    pub(super) progress: &'a dyn crate::btcc::AgentLoopProgress,
    pub(super) model_round_observer: &'a dyn crate::btcc::ModelRoundObserver,
    pub(super) cancellation: CancellationToken,
    pub(super) retry: ModelRouteRetryConfig,
    pub(super) semantic_state: crate::btcc::TurnSemanticState,
    pub(super) view: ViewState,
}

impl ModelRoundPort for RoutedRound<'_> {
    fn context_sizing<'a>(
        &'a self,
        request: ContextSizingRequest<'a>,
    ) -> Result<Option<ContextSizing<'a>>, ModelRoundError> {
        self.base.context_sizing(request)
    }
    fn initial_request_bytes(
        &self,
        prompt: &str,
        instructions: &str,
        data: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        self.base.initial_request_bytes(prompt, instructions, data)
    }
    fn stateless_message_bytes(
        &self,
        messages: &[crate::btcc::agent_loop::ModelRoundMessage],
        data: Option<&str>,
    ) -> Result<Option<usize>, ModelRoundError> {
        self.base.stateless_message_bytes(messages, data)
    }
    fn run_round<'a>(
        &'a self,
        request: ModelRoundRequest<'a>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a,
        >,
    > {
        Box::pin(async move { self.run(request).await })
    }
}

/// Per-round dispatch bookkeeping across retries and candidate fallbacks.
struct RoundCursor<'r> {
    round_id: String,
    /// The candidate whose attempt history is loaded (`turn:round:cursor:model`).
    loaded_key: Option<String>,
    attempt: u32,
    /// The provider continuation; dropped when the route falls back.
    continuation: Option<&'r Value>,
    dispatch_budget: usize,
    dispatches: usize,
    recovery: Recovery,
}

impl RoundCursor<'_> {
    /// After a fallback the next candidate starts from its own history
    /// without the previous candidate's provider continuation.
    fn switch_candidate(&mut self) {
        self.continuation = None;
        self.loaded_key = None;
    }
}

/// Whether a recovery notice is showing and must be cleared on success.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Recovery {
    Idle,
    Active,
}

/// What the dispatch loop does next.
enum Flow {
    /// Dispatch the current attempt.
    Dispatch,
    /// Start the loop over (after a fallback, a superseded start or a retry).
    Restart,
}

impl RoutedRound<'_> {
    async fn terminal_error(&self, error: ModelRoundError) -> ModelRoundError {
        self.model_round_observer.failure(&error).await;
        failure::reduce(error)
    }

    /// Runs one logical round over the route: replays an accepted response,
    /// resumes from attempt history, and dispatches with retry and fallback
    /// until a candidate answers or the route is exhausted.
    async fn run(
        &self,
        request: ModelRoundRequest<'_>,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        let mut guard = self.route.lock().await;
        let route = &mut *guard;
        let mut cursor = RoundCursor {
            round_id: request
                .round_id
                .map(str::to_owned)
                .unwrap_or_else(|| self.view.next_generated_round_id(self.turn_id)),
            loaded_key: None,
            attempt: 1,
            continuation: rebase_continuation(request.bounded_continuation, request.continuation)?,
            dispatch_budget: (route.retry_ceiling as usize * route.candidates.len()).min(30),
            dispatches: 0,
            recovery: Recovery::Idle,
        };
        loop {
            let candidate = route
                .candidates
                .get(route.active_cursor as usize)
                .cloned()
                .ok_or_else(gateway_failed)?;
            visual_freeze(request.image_carrier, &candidate.model_ref)?;
            let key = format!(
                "{}:{}:{}:{}",
                self.turn_id, cursor.round_id, route.active_cursor, candidate.model_ref
            );
            if let Some(result) = self.replay_accepted(route, &cursor, &candidate).await? {
                return Ok(result);
            }
            if cursor.loaded_key.as_deref() != Some(key.as_str()) {
                cursor.loaded_key = Some(key.clone());
                let flow = self
                    .resume_from_history(route, &mut cursor, &candidate, &key, &request)
                    .await?;
                if matches!(flow, Flow::Restart) {
                    continue;
                }
            }
            if self.start_attempt(route, &cursor, &candidate).await? != RouteEventStatus::Recorded {
                cursor.loaded_key = None;
                continue;
            }
            match self
                .dispatch(route, &mut cursor, &candidate, &request)
                .await
            {
                Ok(result) => {
                    return self
                        .accept(route, cursor, candidate, &request, result)
                        .await;
                }
                Err(error) => {
                    self.recover(route, &mut cursor, &candidate, &key, &request, error)
                        .await?;
                }
            }
        }
    }

    /// The durably accepted response of this round and candidate, if any.
    async fn replay_accepted(
        &self,
        route: &RouteState,
        cursor: &RoundCursor<'_>,
        candidate: &RouteCandidate,
    ) -> Result<Option<ModelRoundResult>, ModelRoundError> {
        let Some(value) = self
            .hooks
            .accepted(&cursor.round_id, route.active_cursor, &candidate.model_ref)
            .await?
        else {
            return Ok(None);
        };
        let mut result: ModelRoundResult = serde_json::from_value(value).map_err(|source| {
            failure::durability(
                "response_acceptance_read",
                &BtccError::detected(BtccCode::ModelResponseInvalid, "invalid accepted response")
                    .with_source(source),
            )
        })?;
        result
            .accepted_checkpoint
            .get_or_insert(crate::btcc::agent_loop::AcceptedCheckpoint {
                round_id: cursor.round_id.clone(),
                candidate_index: route.active_cursor,
                transport_attempt: 0,
                model_ref: candidate.model_ref.clone(),
            });
        Ok(Some(result))
    }

    /// Continues from the candidate's durable attempt history after a restart:
    /// abandons open attempts and applies the latest failure's disposition.
    async fn resume_from_history(
        &self,
        route: &mut RouteState,
        cursor: &mut RoundCursor<'_>,
        candidate: &RouteCandidate,
        key: &str,
        request: &ModelRoundRequest<'_>,
    ) -> Result<Flow, ModelRoundError> {
        let history = self
            .hooks
            .history(&cursor.round_id, route.active_cursor, &candidate.model_ref)
            .await?;
        self.abandon_open(
            &cursor.round_id,
            route.active_cursor,
            &candidate.model_ref,
            &history,
        )
        .await?;
        cursor.attempt = max_attempt(&history) + 1;
        let Some(latest) = latest_failure(&history) else {
            return Ok(Flow::Dispatch);
        };
        let exhausted = cursor.attempt > route.retry_ceiling;
        match latest.disposition {
            FailureDisposition::Surface => Err(self.surface_recovered(latest).await),
            FailureDisposition::Retry if !exhausted => {
                self.backoff(
                    cursor.attempt - 1,
                    route.retry_ceiling,
                    &mut cursor.recovery,
                )
                .await?;
                Ok(Flow::Dispatch)
            }
            FailureDisposition::Retry if is_last_candidate(route) => {
                self.report_interrupted(route.retry_ceiling, route.retry_ceiling)
                    .await;
                Err(self.surface_recovered(latest).await)
            }
            FailureDisposition::Advance | FailureDisposition::Retry => {
                self.fallback(route, &cursor.round_id, key, request.image_carrier)
                    .await?;
                cursor.switch_candidate();
                Ok(Flow::Restart)
            }
        }
    }

    async fn surface_recovered(&self, latest: &FailureRecord) -> ModelRoundError {
        let error = recovered(latest);
        self.model_round_observer.failure(&error).await;
        error
    }

    async fn report_interrupted(&self, attempt: u32, max: u32) {
        projection::recovery(
            self.progress,
            self.semantic_state,
            "interrupted",
            attempt,
            max,
        )
        .await;
    }

    /// Records the attempt start and publishes a pending fallback notice for
    /// this candidate. A start the store did not record means another owner
    /// progressed the attempt; the history must be reloaded.
    async fn start_attempt(
        &self,
        route: &RouteState,
        cursor: &RoundCursor<'_>,
        candidate: &RouteCandidate,
    ) -> Result<RouteEventStatus, ModelRoundError> {
        let status = self
            .hooks
            .event(
                event(
                    ModelRouteEventKind::AttemptStarted,
                    &cursor.round_id,
                    route.active_cursor,
                    Some(cursor.attempt),
                    &candidate.model_ref,
                ),
                None,
            )
            .await?;
        let pending = self.view.pending_fallback.lock().take();
        if pending.as_ref() == Some(&(cursor.round_id.clone(), candidate.model_ref.clone())) {
            projection::fallback_started(self.progress, &cursor.round_id, &candidate.model_ref)
                .await;
        } else if let Some(pending) = pending {
            *self.view.pending_fallback.lock() = Some(pending);
        }
        Ok(status)
    }

    /// Sends the physical request for the current candidate, within the
    /// round's dispatch budget.
    async fn dispatch(
        &self,
        route: &RouteState,
        cursor: &mut RoundCursor<'_>,
        candidate: &RouteCandidate,
        request: &ModelRoundRequest<'_>,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        if cursor.dispatches >= cursor.dispatch_budget {
            return Err(ModelRoundError::DispatchLimit);
        }
        cursor.dispatches += 1;
        let usage = request.usage_attribution.cloned().map(|mut value| {
            value.reasoning_effort = Some(candidate.reasoning_effort.clone());
            value
        });
        let mut route_context = butler_core::json::json_object!({"schemaVersion":"butler.model-route-request.v1","routeDigest":route.route_digest,"cursor":route.active_cursor,"modelRef":candidate.model_ref});
        if let Some(digest) = request.tool_surface_digest {
            route_context.insert("toolSurfaceDigest".into(), Value::String(digest.into()));
        }
        let route_context = Value::Object(route_context);
        let physical = ModelRoundRequest {
            max_output_tokens: request.max_output_tokens,
            round_id: Some(&cursor.round_id),
            model: &candidate.model_ref,
            messages: request.messages,
            instructions: request.instructions,
            tools: request.tools,
            tool_surface_digest: request.tool_surface_digest,
            tool_choice: request.tool_choice,
            reasoning_effort: &candidate.reasoning_effort,
            cancellation: request.cancellation.clone(),
            attachments: request.attachments,
            image_carrier: request.image_carrier,
            image_capability: request.image_capability,
            image_manifests: request.image_manifests,
            verified_image_payload: request.verified_image_payload,
            butler_data: request.butler_data,
            usage_attribution: usage.as_ref(),
            cache_scope: request.cache_scope,
            stable_provider_cache_prefix: request.stable_provider_cache_prefix,
            route_context: Some(&route_context),
            provider_retry_attempts: Some(1.0),
            route_transport_attempt_ordinal: request.route_transport_attempt_ordinal,
            continuation: cursor.continuation,
            bounded_continuation: request.bounded_continuation,
            provider_body_admission: request.provider_body_admission,
            stream_observer: request.stream_observer,
            identity_observer: request.identity_observer,
        };
        self.base.run_round(physical).await
    }

    /// Records a failed attempt and decides: retry the candidate, fall back
    /// to the next one (`Ok`), or surface the failure (`Err`).
    async fn recover(
        &self,
        route: &mut RouteState,
        cursor: &mut RoundCursor<'_>,
        candidate: &RouteCandidate,
        key: &str,
        request: &ModelRoundRequest<'_>,
        error: ModelRoundError,
    ) -> Result<(), ModelRoundError> {
        let disposition = failure::classify(&error);
        let mut failed = event(
            ModelRouteEventKind::AttemptFailed,
            &cursor.round_id,
            route.active_cursor,
            Some(cursor.attempt),
            &candidate.model_ref,
        );
        failed.failure = Some(AttemptFailure {
            error_code: failure::code(&error).to_owned(),
            disposition,
        });
        self.hooks.event(failed, None).await?;
        let retry = disposition == FailureDisposition::Retry;
        if disposition == FailureDisposition::Surface {
            return Err(self.terminal_error(error).await);
        }
        if retry && cursor.attempt < route.retry_ceiling {
            self.backoff(cursor.attempt, route.retry_ceiling, &mut cursor.recovery)
                .await?;
            cursor.attempt += 1;
            return Ok(());
        }
        if is_last_candidate(route) {
            if retry {
                self.report_interrupted(cursor.attempt, route.retry_ceiling)
                    .await;
            }
            return Err(self.terminal_error(error).await);
        }
        if retry {
            self.clear_recovery(&mut cursor.recovery, cursor.attempt, route.retry_ceiling)
                .await;
        }
        self.fallback(route, &cursor.round_id, key, request.image_carrier)
            .await?;
        cursor.switch_candidate();
        Ok(())
    }

    /// Durably accepts the response, records the model identity and stamps
    /// the accepted checkpoint.
    async fn accept(
        &self,
        route: &RouteState,
        mut cursor: RoundCursor<'_>,
        candidate: RouteCandidate,
        request: &ModelRoundRequest<'_>,
        result: ModelRoundResult,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        self.clear_recovery(&mut cursor.recovery, cursor.attempt, route.retry_ceiling)
            .await;
        let result = attach_surface(result, request.tool_surface_digest)?;
        let value = serde_json::to_value(&result).map_err(|source| {
            failure::durability(
                "response_acceptance_write",
                &BtccError::detected(
                    BtccCode::ModelResponseInvalid,
                    "cannot encode accepted response",
                )
                .with_source(source),
            )
        })?;
        self.hooks
            .accept(
                &cursor.round_id,
                route.active_cursor,
                cursor.attempt,
                &candidate.model_ref,
                value,
            )
            .await?;
        *self.view.accepted.lock() = Some(identity(request, &candidate.model_ref, &result));
        Ok(ModelRoundResult {
            accepted_checkpoint: Some(crate::btcc::agent_loop::AcceptedCheckpoint {
                round_id: cursor.round_id,
                candidate_index: route.active_cursor,
                transport_attempt: cursor.attempt,
                model_ref: candidate.model_ref,
            }),
            ..result
        })
    }

    async fn abandon_open(
        &self,
        round: &str,
        cursor: u32,
        model: &str,
        history: &AttemptHistory,
    ) -> Result<(), ModelRoundError> {
        for attempt in history.started.iter().filter(|a| {
            !history.failed.contains(a)
                && !history.succeeded.contains(a)
                && !history.abandoned.contains(a)
        }) {
            self.hooks
                .event(
                    event(
                        ModelRouteEventKind::AttemptAbandonedAfterRestart,
                        round,
                        cursor,
                        Some(*attempt),
                        model,
                    ),
                    None,
                )
                .await?;
        }
        Ok(())
    }

    async fn fallback(
        &self,
        route: &mut RouteState,
        round: &str,
        key: &str,
        image: Option<&Value>,
    ) -> Result<(), ModelRoundError> {
        if image.is_some() {
            return Err(ModelRoundError::ImageAdmission {
                code: "image_model_unsupported".into(),
                reason: "visual_fallback_disabled".into(),
            });
        }
        route.active_cursor += 1;
        if !route.consumed_attempts.iter().any(|value| value == key) {
            route.consumed_attempts.push(key.into());
        }
        let candidate = route
            .candidates
            .get(route.active_cursor as usize)
            .ok_or_else(gateway_failed)?;
        let route_value = serde_json::to_value(&*route).map_err(|source| {
            ModelRoundError::Integrity(
                BtccError::detected(BtccCode::ModelRouteInvalid, "cannot encode model route")
                    .with_source(source),
            )
        })?;
        self.hooks
            .event(
                event(
                    ModelRouteEventKind::FallbackSelected,
                    round,
                    route.active_cursor,
                    None,
                    &candidate.model_ref,
                ),
                Some(route_value),
            )
            .await?;
        *self.view.active.lock() = candidate.model_ref.clone();
        *self.view.pending_fallback.lock() = Some((round.into(), candidate.model_ref.clone()));
        projection::fallback(
            self.progress,
            self.semantic_state,
            &self.view,
            self.turn_id,
            round,
            route.active_cursor,
            &candidate.model_ref,
        )
        .await;
        Ok(())
    }

    async fn backoff(
        &self,
        attempt: u32,
        max: u32,
        recovery: &mut Recovery,
    ) -> Result<(), ModelRoundError> {
        *recovery = Recovery::Active;
        projection::recovery(
            self.progress,
            self.semantic_state,
            "recovering",
            attempt,
            max,
        )
        .await;
        let multiplier = 2_f64.powi(i32::try_from(attempt.saturating_sub(1)).unwrap_or(i32::MAX));
        let delay =
            Duration::from_secs_f64((self.retry.base_delay_ms * multiplier).min(5_000.0) / 1_000.0);
        tokio::select! {
            () = tokio::time::sleep(delay) => Ok(()),
            () = self.cancellation.cancelled() => Err(ModelRoundError::Cancelled),
        }
    }

    async fn clear_recovery(&self, recovery: &mut Recovery, attempt: u32, max: u32) {
        if *recovery == Recovery::Idle {
            return;
        }
        *recovery = Recovery::Idle;
        projection::recovery(self.progress, self.semantic_state, "cleared", attempt, max).await;
    }
}

fn is_last_candidate(route: &RouteState) -> bool {
    route.active_cursor as usize + 1 >= route.candidates.len()
}

fn gateway_failed() -> ModelRoundError {
    ModelRoundError::Operational(crate::btcc::RuntimeFailure {
        code: "gateway_failed".into(),
        retryable: true,
    })
}
