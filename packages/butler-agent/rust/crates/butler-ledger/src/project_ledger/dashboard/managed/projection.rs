use serde_json::Value;

use super::{child, invalid, required_string};
use crate::project_ledger::ProjectLedgerReadError;
use crate::project_ledger::dashboard::{DashboardCheckpointSummary, DashboardDispositionSummary};

pub(super) fn checkpoint_summary(
    value: &Value,
) -> Result<DashboardCheckpointSummary, ProjectLedgerReadError> {
    let checkpoint = value.get("checkpoint").ok_or_else(invalid)?;
    Ok(DashboardCheckpointSummary {
        created_at: required_string(checkpoint, "createdAt")?.to_owned(),
        public_summary: checkpoint
            .get("publicSummary")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .to_owned(),
        next_step: checkpoint
            .get("nextStep")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .to_owned(),
    })
}

pub(super) fn disposition_summary(
    value: &Value,
) -> Result<DashboardDispositionSummary, ProjectLedgerReadError> {
    let disposition = value.get("disposition").ok_or_else(invalid)?;
    required_string(disposition, "disposition")?;
    Ok(DashboardDispositionSummary {
        created_at: required_string(disposition, "createdAt")?.to_owned(),
        summary: required_string(disposition, "summary")?.to_owned(),
        next_condition: disposition
            .get("nextCondition")
            .and_then(Value::as_str)
            .map(str::to_owned),
        remaining_actions: child::strings(
            disposition.get("remainingActions").ok_or_else(invalid)?,
        )?,
        followups: child::strings(disposition.get("followups").ok_or_else(invalid)?)?,
    })
}
