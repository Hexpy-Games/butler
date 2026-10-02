//! Feedback promotions reuse the Instructions transaction and its recovery.
use super::transaction::{Intent, Request};
use super::*;

impl RememberedRuleOwner {
    /// Promote a classified mandate only while its feedback revision is current.
    pub async fn remember_feedback(
        &self,
        input: ExplicitMemoryUpdateInput,
        feedback: crate::cognition::FeedbackPromotion,
        cancellation: CancellationToken,
    ) -> CognitionResult<RememberedRuleReceipt> {
        let entry = feedback.entry(
            &self
                .environment
                .cognition_root(&self.data_root)
                .join("feedback"),
        )?;
        let target: Option<RememberedRuleTarget> = entry
            .extra_fields
            .get("instruction_target")
            .map(|value| serde_json::from_str(value).map_err(failure_source))
            .transpose()?;
        if target
            .as_ref()
            .is_some_and(|target| target.project_id != input.project_id)
        {
            return Err(failure("rule_binding_mismatch"));
        }
        self.run(
            Some(Request::Remember {
                input,
                target,
                feedback: Some(feedback),
            }),
            cancellation,
        )
        .await?
        .ok_or_else(|| failure("rule_receipt_missing"))
    }
}

pub(super) fn valid(owner: &RememberedRuleOwner, intent: &Intent) -> CognitionResult<bool> {
    let Request::Remember {
        feedback: Some(feedback),
        ..
    } = &intent.request
    else {
        return Ok(true);
    };
    // A destination committed before reset belongs to the Instructions kind.
    let inventory = super::inventory::read_json::<Inventory>(&owner.root().join("manifest.json"))?
        .unwrap_or_default();
    if inventory
        .scopes
        .values()
        .flat_map(|rows| rows.values())
        .any(|row| {
            row.handle == intent.entry.handle
                && row.revision == intent.entry.revision
                && row.state == "active"
        })
    {
        return Ok(true);
    }
    let root = owner
        .environment
        .cognition_root(&owner.data_root)
        .join("feedback");
    match feedback.entry(&root) {
        Ok(_) => Ok(true),
        Err(error) if error.code() == "memory_source_changed" => Ok(false),
        Err(error) => Err(error),
    }
}
pub(super) fn resolve(
    owner: &RememberedRuleOwner,
    intent: &Intent,
    destination: &str,
) -> CognitionResult<()> {
    if let Request::Remember {
        feedback: Some(feedback),
        ..
    } = &intent.request
    {
        feedback.resolve(
            &owner
                .environment
                .cognition_root(&owner.data_root)
                .join("feedback"),
            destination,
        )?;
    }
    Ok(())
}
