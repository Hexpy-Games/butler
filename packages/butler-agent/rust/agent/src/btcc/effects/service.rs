use std::sync::Arc;

use super::contracts::*;
use super::{blockers, execution, identity, outcomes};

pub(crate) struct NativeEffectService {
    journal: Arc<dyn EffectJournal>,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
    fault: Arc<dyn EffectFaultHook>,
}
impl NativeEffectService {
    pub(crate) fn new(
        journal: Arc<dyn EffectJournal>,
        clock: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self::with_fault_points(journal, clock, Arc::new(NoEffectFault))
    }

    /// `fault` is consulted at each durable crash point (before/after intent,
    /// dispatch and receipt); production never interrupts.
    pub(crate) fn with_fault_points(
        journal: Arc<dyn EffectJournal>,
        clock: Arc<dyn Fn() -> String + Send + Sync>,
        fault: Arc<dyn EffectFaultHook>,
    ) -> Self {
        Self {
            journal,
            clock,
            fault,
        }
    }
    pub(crate) async fn execute(&self, input: ExecuteEffect) -> EffectResult<EffectOutcome> {
        if let Some(denied) = outcomes::permission(&input) {
            if input.signal.is_cancelled()
                && let Some(replay) = self.stored_uncertain_replay(&input).await?
            {
                return Ok(replay);
            }
            return Ok(EffectOutcome::Rejected(denied));
        }
        let resolved = match identity::resolve(&input) {
            Ok(value) => value,
            Err(error) => {
                return Ok(EffectOutcome::Rejected(EffectError::new(
                    error.code(),
                    error.message(),
                )));
            }
        };
        let identity = &resolved.identity;
        self.fault.reached("before_intent", identity).await?;
        let hint = input.adapter.recovery_hint(&resolved.normalized_input)?;
        let prepared = self.journal.prepare(identity.clone(), hint).await?;
        let (created, initial) = match prepared {
            PrepareEffect::Ready { created, record } => (created, record),
            PrepareEffect::Conflict(message) => {
                return Ok(EffectOutcome::Rejected(EffectError::new(
                    "effect_identity_conflict",
                    message,
                )));
            }
        };
        if created {
            self.fault.reached("after_intent", identity).await?;
        }
        match initial.status {
            EffectStatus::Applied => return Ok(outcomes::replay(&initial)),
            EffectStatus::Uncertain => return Ok(outcomes::stored_uncertain(&initial)),
            _ => {}
        }
        let context = execution::Context {
            input: &input,
            resolved: &resolved,
            journal: self.journal.as_ref(),
            clock: &*self.clock,
            fault: self.fault.as_ref(),
        };
        if initial.status != EffectStatus::Failed
            && let Some(outcome) = blockers::reconcile(&context, &initial).await?
        {
            return Ok(outcome);
        }
        match execution::continue_effect(&context, &initial).await {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                let current = self.journal.find(identity.effect_id.clone()).await?;
                if let Some(record) = current.as_ref() {
                    if record.status == EffectStatus::Applied {
                        return Ok(outcomes::replay(record));
                    }
                    if record.status == EffectStatus::Dispatching && record.dispatch_attempts > 0 {
                        return execution::reconcile(&context, record).await;
                    }
                }
                Err(error)
            }
        }
    }
    async fn stored_uncertain_replay(
        &self,
        input: &ExecuteEffect,
    ) -> EffectResult<Option<EffectOutcome>> {
        let Ok(resolved) = identity::resolve(input) else {
            return Ok(None);
        };
        let Some(record) = self
            .journal
            .find(resolved.identity.effect_id.clone())
            .await?
        else {
            return Ok(None);
        };
        if record.status != EffectStatus::Uncertain
            || !outcomes::same_identity(&record, &resolved.identity)
        {
            return Ok(None);
        }
        Ok(Some(outcomes::stored_uncertain(&record)))
    }
}
