//! Durable Work closeout adapter for the actual guided Turn.
//!
//! Work state always comes from the bound durable service. A tool's `ok` bit
//! only triggers a re-read; it never grants report authority by itself.

mod closeout;
mod decision;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use crate::btcc::{
    AcceptedWorkResult, BatchDisposition, BtccError, CandidateDisposition, DurableWorkService,
    DurableWorkStatus, GuidedInvocation, ModelRoundToolCall, PortFuture, ToolResult,
    WorkFinalState, WorkPort, WorkStatus, WorkTurnScope, WorkView,
};

pub(crate) struct NativeGuidedWork {
    service: Arc<DurableWorkService>,
    scope: WorkTurnScope,
    tracking_mode: String,
    response_language: String,
    original_request: String,
}

impl NativeGuidedWork {
    pub(crate) fn new(
        service: Arc<DurableWorkService>,
        scope: WorkTurnScope,
        tracking_mode: String,
        role: &str,
        response_language: String,
        original_request: String,
    ) -> Result<Self, BtccError> {
        let _ = role;
        Ok(Self {
            service,
            scope,
            tracking_mode,
            response_language,
            original_request,
        })
    }

    async fn bound(&self) -> Result<Option<WorkView>, BtccError> {
        self.service
            .bound_work_for_turn(self.scope.turn_id.clone())
            .await
    }

    fn check_turn(&self, invocation: GuidedInvocation<'_>) -> Result<(), BtccError> {
        if invocation.turn.turn_id == self.scope.turn_id
            && invocation.turn.session_id == self.scope.session_id
        {
            Ok(())
        } else {
            Err(BtccError::new(
                "guided_work_scope_mismatch",
                "Guided Work scope changed",
            ))
        }
    }

    async fn candidate(&self, text: &str) -> Result<CandidateDisposition, BtccError> {
        if self.tracking_mode == "none" {
            return Ok(CandidateDisposition::Accepted(None));
        }
        let bound = self.bound().await?;
        if let decision::ReportDecision::Continue(observation) =
            decision::decide(bound.as_ref(), &self.scope.turn_id, false)?
        {
            if bound.is_none() {
                return Ok(CandidateDisposition::Accepted(None));
            }
            let bound = bound.as_ref().expect("checked above");
            if !self
                .service
                .claim_closeout_correction(crate::btcc::ClaimCloseoutCorrectionInput {
                    scope: self.scope.clone(),
                    work_id: bound.work_id.clone(),
                })
                .await?
            {
                return Ok(CandidateDisposition::Accepted(Some(
                    closeout::settle_open(self, bound, text).await?,
                )));
            }
            return Ok(CandidateDisposition::Continue(observation.into()));
        }
        let Some(bound) = bound else {
            return Ok(CandidateDisposition::Accepted(None));
        };
        if bound
            .latest_disposition
            .as_ref()
            .is_some_and(|item| item.runtime_owned_open)
        {
            Ok(CandidateDisposition::Accepted(Some(closeout::notice(
                self, text,
            ))))
        } else {
            Ok(CandidateDisposition::Accepted(None))
        }
    }

    async fn reconcile_text(&self, text: &str) -> Result<String, BtccError> {
        if self.tracking_mode == "none" {
            return Ok(text.into());
        }
        let bound = self.bound().await?;
        let Some(bound) = bound else {
            return Ok(text.into());
        };
        if decision::fresh(Some(&bound), &self.scope.turn_id)? {
            return Ok(
                if bound
                    .latest_disposition
                    .as_ref()
                    .is_some_and(|item| item.runtime_owned_open)
                {
                    closeout::notice(self, text)
                } else {
                    text.into()
                },
            );
        }
        closeout::settle_open(self, &bound, text).await
    }
}

impl WorkPort for NativeGuidedWork {
    fn after_batch<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        calls: &'a [ModelRoundToolCall],
        results: &'a [ToolResult],
        _: u32,
    ) -> PortFuture<'a, BatchDisposition> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            let final_disposition = calls
                .last()
                .is_some_and(|call| call.name == "record_work_disposition")
                && results
                    .last()
                    .is_some_and(|result| result.ok && result.name == "record_work_disposition");
            let waiting = calls.last().is_some_and(|call| {
                matches!(
                    call.name.as_str(),
                    "delegate_to_steward" | "wait_for_worker"
                )
            }) && results.last().is_some_and(|result| result.ok);
            if waiting {
                return Ok(BatchDisposition::Wait);
            }
            if !final_disposition {
                return Ok(BatchDisposition::Continue);
            }
            let bound = self.bound().await?;
            Ok(
                if matches!(
                    decision::decide(bound.as_ref(), &self.scope.turn_id, false)?,
                    decision::ReportDecision::Report(_)
                ) && bound.is_some()
                {
                    BatchDisposition::FinalReport
                } else {
                    BatchDisposition::Continue
                },
            )
        })
    }

    fn review_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        _: u32,
    ) -> PortFuture<'a, CandidateDisposition> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            match self.candidate(text).await {
                Err(error) if closeout::publication_failure(&error) => {
                    Ok(CandidateDisposition::Accepted(None))
                }
                result => result,
            }
        })
    }

    fn reconcile<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        content: &'a str,
    ) -> PortFuture<'a, String> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            match self.reconcile_text(content).await {
                Err(error) if closeout::publication_failure(&error) => Ok(content.into()),
                result => result,
            }
        })
    }

    fn final_state<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, WorkFinalState> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            let bound = self.bound().await?;
            Ok(WorkFinalState {
                status: bound.as_ref().map(|work| match work.status {
                    DurableWorkStatus::Open => WorkStatus::Open,
                    DurableWorkStatus::Completed => WorkStatus::Completed,
                    DurableWorkStatus::Blocked => WorkStatus::Blocked,
                    DurableWorkStatus::Abandoned => WorkStatus::Abandoned,
                }),
                has_work: bound.is_some(),
            })
        })
    }

    fn accepted_result<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<AcceptedWorkResult>> {
        Box::pin(async move {
            self.check_turn(invocation)?;
            let bound = self.bound().await?;
            Ok(
                match decision::decide(bound.as_ref(), &self.scope.turn_id, false)? {
                    decision::ReportDecision::Report(result) => result,
                    decision::ReportDecision::Continue(_) => None,
                },
            )
        })
    }
}
