//! Explicit historical transcript and app projection recovery.

mod classifier;
mod identity;
mod import;
mod input;
mod report;

#[cfg(any(test, feature = "test-support"))]
pub(crate) use identity::historical_source_ref;
#[cfg(any(test, feature = "test-support"))]
pub(crate) use input::{HistoricalAppProjectionRow, HistoricalTranscriptRow};
pub use input::{
    HistoricalRecoveryInput, read_historical_app_rows, read_historical_transcript_rows,
};

use serde_json::Value;

use self::classifier::classify_rows;
use self::import::{Outcome, planned_outcome, planned_outcome_connection};
use super::{AgentConversationStore, ConversationResult, ConversationSourceReader};

/// Plans the recovery of historical rows into the conversation store (the JSON report).
pub fn plan_historical_recovery(
    reader: Option<&ConversationSourceReader>,
    parse_timestamp: &dyn Fn(&str) -> Option<i64>,
    input: &HistoricalRecoveryInput,
) -> ConversationResult<Value> {
    let decisions = classify_rows(&input.transcript_rows, &input.app_rows, parse_timestamp);
    let outcomes = decisions
        .iter()
        .map(|decision| planned_outcome(reader, decision))
        .collect::<ConversationResult<Vec<_>>>()?;
    Ok(report::report(&decisions, &outcomes, input.dry_run))
}

impl AgentConversationStore {
    /// Plans and, unless `dry_run`, applies the historical recovery; returns its report.
    pub async fn run_historical_recovery(
        &self,
        input: HistoricalRecoveryInput,
        parse_timestamp: &dyn Fn(&str) -> Option<i64>,
    ) -> ConversationResult<Value> {
        let decisions = classify_rows(&input.transcript_rows, &input.app_rows, parse_timestamp);
        let dry_run = input.dry_run;
        let clock = self.identity_clock().clone();
        let (decisions, outcomes) = self
            .execute(move |connection| {
                let mut outcomes = Vec::with_capacity(decisions.len());
                for decision in &decisions {
                    if !decision.admit {
                        outcomes.push(Outcome::default());
                    } else if dry_run {
                        outcomes.push(planned_outcome_connection(connection, decision)?);
                    } else {
                        outcomes.push(import::import_one(connection, clock.as_ref(), decision)?);
                    }
                }
                Ok((decisions, outcomes))
            })
            .await?;
        Ok(report::report(&decisions, &outcomes, dry_run))
    }
}
