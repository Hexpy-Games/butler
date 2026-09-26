//! Source-order receipt bytes without cloning the nested result DOM.

use crate::btcc::effects::contracts::{EffectFailure, EffectReceipt, EffectResult};

fn field(output: &mut String, name: &str, value: &str, first: bool) -> EffectResult<()> {
    if !first {
        output.push(',');
    }
    crate::json::write_string(name, output).map_err(error)?;
    output.push(':');
    crate::json::write_string(value, output).map_err(error)
}
fn error(error: crate::json::JsonError) -> EffectFailure {
    EffectFailure::policy("effect_journal_json", error.to_string()).with_source(error)
}

pub(super) fn encode(receipt: &EffectReceipt) -> EffectResult<String> {
    let mut output = String::with_capacity(768);
    output.push('{');
    for (index, (name, value)) in [
        ("effectId", receipt.effect_id.as_str()),
        ("receiptId", receipt.receipt_id.as_str()),
        ("idempotencyKey", receipt.idempotency_key.as_str()),
        ("identitySha256", receipt.identity_sha256.as_str()),
        ("requestSha256", receipt.request_sha256.as_str()),
        ("inputSha256", receipt.input_sha256.as_str()),
        ("targetSha256", receipt.target_sha256.as_str()),
        ("workId", receipt.work_id.as_str()),
        ("planRevisionId", receipt.plan_revision_id.as_str()),
        ("actionKey", receipt.action_key.as_str()),
        ("capability", receipt.capability.as_str()),
        ("sanitizedTarget", receipt.sanitized_target.as_str()),
    ]
    .into_iter()
    .enumerate()
    {
        field(&mut output, name, value, index == 0)?;
    }
    output.push_str(",\"result\":");
    output.push_str(receipt.result.as_str());
    output.push_str(",\"appliedAt\":");
    crate::json::write_string(&receipt.applied_at, &mut output).map_err(error)?;
    if let Some(attempt) = &receipt.dispatch_attempt {
        output.push_str(",\"dispatchAttempt\":");
        crate::json::append_json(attempt, &mut output).map_err(error)?;
    }
    output.push('}');
    Ok(output)
}
