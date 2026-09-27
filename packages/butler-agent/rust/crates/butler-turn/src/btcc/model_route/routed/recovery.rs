//! Recovery of a failed routed attempt: abandon, fallback, backoff.

use super::*;

impl RoutedRound<'_> {
    /// Records a failed attempt and decides: retry the candidate, fall back
    /// to the next one (`Ok`), or surface the failure (`Err`).
    pub(super) async fn recover(
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
    pub(super) async fn accept(
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
        self.hooks
            .accept(
                &cursor.round_id,
                route.active_cursor,
                cursor.attempt,
                &candidate.model_ref,
                result.clone(),
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

    pub(super) async fn abandon_open(
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

    // Passthrough: image admission and attachment documents owned by butler-runtime.
    pub(super) async fn fallback(
        &self,
        route: &mut RouteState,
        round: &str,
        key: &str,
        // Passthrough: image admission and attachment documents owned by butler-runtime.
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

        self.hooks
            .event(
                event(
                    ModelRouteEventKind::FallbackSelected,
                    round,
                    route.active_cursor,
                    None,
                    &candidate.model_ref,
                ),
                Some(route.clone()),
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

    pub(super) async fn backoff(
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

    pub(super) async fn clear_recovery(&self, recovery: &mut Recovery, attempt: u32, max: u32) {
        if *recovery == Recovery::Idle {
            return;
        }
        *recovery = Recovery::Idle;
        projection::recovery(self.progress, self.semantic_state, "cleared", attempt, max).await;
    }
}
