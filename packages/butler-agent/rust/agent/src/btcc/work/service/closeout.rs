use crate::btcc::BtccError;

use super::{DurableWorkService, fingerprint, object_mut, serialized};
use crate::btcc::work::contracts::*;

impl DurableWorkService {
    pub(crate) async fn record_disposition(
        &self,
        input: DispositionInput,
    ) -> Result<WorkView, BtccError> {
        super::super::validation::validate_disposition(&input)?;
        let mut identity = serialized(&input)?;
        let object = object_mut(&mut identity)?;
        object.remove("backfillToolCallIds");
        object.remove("expectedMaterialFingerprint");
        let request_sha256 = fingerprint("record_work_disposition", &identity)?;
        let command = DispositionCommand {
            normalized_summary: crate::public_text::trim_js_whitespace(&input.summary).into(),
            action_updates: input.action_updates.clone().unwrap_or_default(),
            remaining_actions: input.remaining_actions.clone().unwrap_or_default(),
            evidence_refs: input.evidence_refs.clone().unwrap_or_default(),
            followups: input.followups.clone().unwrap_or_default(),
            input,
            request_sha256,
        };
        self.repository.record_disposition(command).await
    }

    pub(crate) async fn claim_closeout_correction(
        &self,
        input: ClaimCloseoutCorrectionInput,
    ) -> Result<bool, BtccError> {
        super::super::validation::validate_closeout_missing(&input)?;
        self.repository.claim_closeout_correction(input).await
    }
}
