use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::btcc::BtccError;
use crate::btcc::agent_loop::{
    ModelRoundError, ModelRoundPort, ModelRoundRequest, ModelRoundResult,
};

use super::contracts::{
    AttemptHistory, ContextSizing, ContextSizingRequest, FailureDisposition, ModelRouteRetryConfig,
    RouteState,
};
use super::execution::ViewState;
use super::support::*;
use super::{failure, hooks::RouteHooks, projection};

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

impl RoutedRound<'_> {
    async fn terminal_error(&self, error: ModelRoundError) -> ModelRoundError {
        self.model_round_observer.failure(&error).await;
        failure::reduce(error)
    }

    async fn run(
        &self,
        request: ModelRoundRequest<'_>,
    ) -> Result<ModelRoundResult, ModelRoundError> {
        let mut route = self.route.lock().await;
        let round_id = request
            .round_id
            .map(str::to_owned)
            .unwrap_or_else(|| self.view.next_generated_round_id(self.turn_id));
        let mut loaded_key = None;
        let mut attempt = 1;
        let mut continuation =
            rebase_continuation(request.bounded_continuation, request.continuation)?;
        let dispatch_budget = (route.retry_ceiling as usize * route.candidates.len()).min(30);
        let mut dispatches = 0;
        let mut recovery_active = false;
        loop {
            let candidate = route
                .candidates
                .get(route.active_cursor as usize)
                .cloned()
                .ok_or_else(gateway_failed)?;
            visual_freeze(request.image_carrier, &candidate.model_ref)?;
            let key = format!(
                "{}:{round_id}:{}:{}",
                self.turn_id, route.active_cursor, candidate.model_ref
            );
            if let Some(value) = self
                .hooks
                .accepted(&round_id, route.active_cursor, &candidate.model_ref)
                .await?
            {
                let mut result: ModelRoundResult = serde_json::from_value(value).map_err(|_| {
                    failure::durability(
                        "response_acceptance_read",
                        BtccError::new("model_response_invalid", "invalid accepted response"),
                    )
                })?;
                result.accepted_checkpoint.get_or_insert(
                    crate::btcc::agent_loop::AcceptedCheckpoint {
                        round_id: round_id.clone(),
                        candidate_index: route.active_cursor,
                        transport_attempt: 0,
                        model_ref: candidate.model_ref.clone(),
                    },
                );
                return Ok(result);
            }
            if loaded_key.as_deref() != Some(key.as_str()) {
                loaded_key = Some(key.clone());
                let history: AttemptHistory = serde_json::from_value(
                    self.hooks
                        .history(&round_id, route.active_cursor, &candidate.model_ref)
                        .await?,
                )
                .map_err(|_| {
                    failure::durability(
                        "attempt_history_read",
                        BtccError::new("model_history_invalid", "invalid model route history"),
                    )
                })?;
                self.abandon_open(
                    &round_id,
                    route.active_cursor,
                    &candidate.model_ref,
                    &history,
                )
                .await?;
                attempt = max_attempt(&history) + 1;
                if let Some(latest) = latest_failure(&history) {
                    match latest.disposition {
                        FailureDisposition::Surface => {
                            let error = recovered(latest);
                            self.model_round_observer.failure(&error).await;
                            return Err(error);
                        }
                        FailureDisposition::Advance => {
                            self.fallback(&mut route, &round_id, &key, request.image_carrier)
                                .await?;
                            continuation = None;
                            loaded_key = None;
                            continue;
                        }
                        FailureDisposition::Retry if attempt <= route.retry_ceiling => {
                            self.backoff(attempt - 1, route.retry_ceiling, &mut recovery_active)
                                .await?;
                        }
                        FailureDisposition::Retry => {
                            if route.active_cursor as usize + 1 >= route.candidates.len() {
                                projection::recovery(
                                    self.progress,
                                    self.semantic_state,
                                    "interrupted",
                                    route.retry_ceiling,
                                    route.retry_ceiling,
                                )
                                .await;
                                let error = recovered(latest);
                                self.model_round_observer.failure(&error).await;
                                return Err(error);
                            }
                            self.fallback(&mut route, &round_id, &key, request.image_carrier)
                                .await?;
                            continuation = None;
                            loaded_key = None;
                            continue;
                        }
                    }
                }
            }
            let started = self
                .hooks
                .event(
                    event(
                        "model.attempt.started",
                        &round_id,
                        route.active_cursor,
                        Some(attempt),
                        &candidate.model_ref,
                        None,
                    ),
                    None,
                )
                .await?;
            let pending = self.view.pending_fallback.lock().take();
            if pending.as_ref() == Some(&(round_id.clone(), candidate.model_ref.clone())) {
                projection::fallback_started(self.progress, &round_id, &candidate.model_ref).await;
            } else if let Some(pending) = pending {
                *self.view.pending_fallback.lock() = Some(pending);
            }
            if let Some(status) = status(&started)
                && status != "recorded"
            {
                loaded_key = None;
                continue;
            }
            let usage = request.usage_attribution.cloned().map(|mut value| {
                value.reasoning_effort = Some(candidate.reasoning_effort.clone());
                value
            });
            let mut route_context = crate::json::json_object!({"schemaVersion":"butler.model-route-request.v1","routeDigest":route.route_digest,"cursor":route.active_cursor,"modelRef":candidate.model_ref});
            if let Some(digest) = request.tool_surface_digest {
                route_context.insert("toolSurfaceDigest".into(), Value::String(digest.into()));
            }
            let route_context = Value::Object(route_context);
            let physical = ModelRoundRequest {
                max_output_tokens: request.max_output_tokens,
                round_id: Some(&round_id),
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
                continuation,
                bounded_continuation: request.bounded_continuation,
                provider_body_admission: request.provider_body_admission,
                stream_observer: request.stream_observer,
                identity_observer: request.identity_observer,
            };
            let dispatched = if dispatches >= dispatch_budget {
                Err(ModelRoundError::DispatchLimit)
            } else {
                dispatches += 1;
                self.base.run_round(physical).await
            };
            let result = match dispatched {
                Ok(result) => result,
                Err(error) => {
                    let disposition = failure::classify(&error);
                    let code = failure::code(&error).to_owned();
                    self.hooks
                        .event(
                            event(
                                "model.attempt.failed",
                                &round_id,
                                route.active_cursor,
                                Some(attempt),
                                &candidate.model_ref,
                                Some((&code, disposition)),
                            ),
                            None,
                        )
                        .await?;
                    if disposition == FailureDisposition::Surface {
                        return Err(self.terminal_error(error).await);
                    }
                    if disposition == FailureDisposition::Retry && attempt < route.retry_ceiling {
                        self.backoff(attempt, route.retry_ceiling, &mut recovery_active)
                            .await?;
                        attempt += 1;
                        continue;
                    }
                    if route.active_cursor as usize + 1 >= route.candidates.len() {
                        if disposition == FailureDisposition::Retry {
                            projection::recovery(
                                self.progress,
                                self.semantic_state,
                                "interrupted",
                                attempt,
                                route.retry_ceiling,
                            )
                            .await;
                        }
                        return Err(self.terminal_error(error).await);
                    }
                    if disposition == FailureDisposition::Retry {
                        self.clear_recovery(&mut recovery_active, attempt, route.retry_ceiling)
                            .await;
                    }
                    self.fallback(&mut route, &round_id, &key, request.image_carrier)
                        .await?;
                    continuation = None;
                    loaded_key = None;
                    continue;
                }
            };
            self.clear_recovery(&mut recovery_active, attempt, route.retry_ceiling)
                .await;
            let result = attach_surface(result, request.tool_surface_digest)?;
            let value = serde_json::to_value(&result).map_err(|_| {
                failure::durability(
                    "response_acceptance_write",
                    BtccError::new("model_response_invalid", "cannot encode accepted response"),
                )
            })?;
            self.hooks
                .accept(
                    &round_id,
                    route.active_cursor,
                    attempt,
                    &candidate.model_ref,
                    value,
                )
                .await?;
            *self.view.accepted.lock() = Some(identity(&request, &candidate.model_ref, &result));
            return Ok(ModelRoundResult {
                accepted_checkpoint: Some(crate::btcc::agent_loop::AcceptedCheckpoint {
                    round_id,
                    candidate_index: route.active_cursor,
                    transport_attempt: attempt,
                    model_ref: candidate.model_ref,
                }),
                ..result
            });
        }
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
                        "model.attempt.abandoned_after_restart",
                        round,
                        cursor,
                        Some(*attempt),
                        model,
                        None,
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
        let route_value = serde_json::to_value(&*route).map_err(|_| {
            ModelRoundError::Integrity(BtccError::new(
                "model_route_invalid",
                "cannot encode model route",
            ))
        })?;
        self.hooks
            .event(
                event(
                    "model.fallback.selected",
                    round,
                    route.active_cursor,
                    None,
                    &candidate.model_ref,
                    None,
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
        active: &mut bool,
    ) -> Result<(), ModelRoundError> {
        *active = true;
        projection::recovery(
            self.progress,
            self.semantic_state,
            "recovering",
            attempt,
            max,
        )
        .await;
        let multiplier = 2_f64.powi(attempt.saturating_sub(1) as i32);
        let delay =
            Duration::from_secs_f64((self.retry.base_delay_ms * multiplier).min(5_000.0) / 1_000.0);
        tokio::select! {
            () = tokio::time::sleep(delay) => Ok(()),
            () = self.cancellation.cancelled() => Err(ModelRoundError::Cancelled),
        }
    }

    async fn clear_recovery(&self, active: &mut bool, attempt: u32, max: u32) {
        if !*active {
            return;
        }
        *active = false;
        projection::recovery(self.progress, self.semantic_state, "cleared", attempt, max).await;
    }
}

fn gateway_failed() -> ModelRoundError {
    ModelRoundError::Operational(crate::btcc::RuntimeFailure {
        code: "gateway_failed".into(),
        retryable: true,
    })
}
