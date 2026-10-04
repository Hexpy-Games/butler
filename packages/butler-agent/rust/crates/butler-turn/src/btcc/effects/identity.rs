use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::contracts::{EffectFailure, EffectIdentity, EffectResult, ExecuteEffect, PlanBinding};

pub(super) struct Resolved {
    pub identity: EffectIdentity,
    pub normalized_target: String,
    // Passthrough: EffectAdapter input is capability-generic tool input.
    pub normalized_input: Value,
}

#[derive(Clone, Copy)]
pub(super) struct IdentityParts<'a> {
    pub work_id: &'a str,
    pub plan_revision_id: &'a str,
    pub action_key: &'a str,
    pub binding: PlanBinding,
    pub occurrence: Option<&'a str>,
    pub capability: &'a str,
    pub normalized_target: &'a str,
    pub sanitized_target: &'a str,
    // Passthrough: EffectAdapter input is capability-generic tool input.
    pub normalized_input: &'a Value,
}

pub(super) fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// The effect id of an accepted-plan effect occurrence.
pub fn accepted_plan_effect_id(
    work_id: &str,
    plan_revision_id: &str,
    capability: &str,
    occurrence_id: &str,
) -> EffectResult<String> {
    let occurrence = butler_core::public_text::trim_js_whitespace(occurrence_id);
    required(occurrence, "runtime occurrence")?;
    let slot = json!({"version":1,"workId":work_id,"planRevisionId":plan_revision_id,
        "actionKey":"accepted-plan","capability":capability,
        "occurrenceSha256":digest(occurrence)});
    Ok(format!("guided-effect-{}", digest(&stable(&slot)?)))
}

/// The digest of an effect input's stable JSON.
// Passthrough: EffectAdapter input is capability-generic tool input.
pub fn effect_input_sha256(value: &Value) -> EffectResult<String> {
    Ok(digest(&stable(value)?))
}

// Passthrough: EffectAdapter input is capability-generic tool input.
pub(super) fn stable(value: &Value) -> EffectResult<String> {
    butler_core::json::stringify_sorted(value, &|left, right| {
        left.encode_utf16().cmp(right.encode_utf16())
    })
    .map_err(|error| {
        EffectFailure::policy("effect_request_invalid", error.to_string()).with_source(error)
    })
}

fn required(value: &str, label: &str) -> EffectResult<()> {
    if butler_core::public_text::trim_js_whitespace(value).is_empty() {
        Err(EffectFailure::policy(
            "effect_request_invalid",
            format!("Effect {label} must not be empty"),
        ))
    } else {
        Ok(())
    }
}
fn invalid(error: EffectFailure) -> EffectFailure {
    EffectFailure::policy("effect_request_invalid", error.message().to_owned()).with_source(error)
}

pub(super) fn resolve(input: &ExecuteEffect) -> EffectResult<Resolved> {
    // Plan revisions are tracking metadata, never execution authority.
    let plan_revision_id = input
        .work
        .current_plan
        .as_ref()
        .map_or("", |plan| plan.plan_revision_id.as_str());
    let adapter = input.adapter.as_ref();
    required(adapter.capability(), "adapter capability")?;
    let normalized_target = adapter.normalize_target(&input.target).map_err(invalid)?;
    required(&normalized_target, "normalized target")?;
    let binding = PlanBinding::AcceptedPlan;
    let action_key = "accepted-plan";
    let occurrence = if binding == PlanBinding::AcceptedPlan {
        let value = input.occurrence_id.as_deref().unwrap_or("");
        required(value, "runtime effect occurrence")?;
        Some(butler_core::public_text::trim_js_whitespace(value))
    } else {
        None
    };
    let normalized_input = adapter.normalize_input(&input.input).map_err(invalid)?;
    let sanitized_target = adapter
        .sanitize_target(&normalized_target)
        .map_err(invalid)?;
    required(&sanitized_target, "sanitized target")?;
    let identity = build_identity(IdentityParts {
        work_id: &input.work.work_id,
        plan_revision_id,
        action_key,
        binding,
        occurrence,
        capability: adapter.capability(),
        normalized_target: &normalized_target,
        sanitized_target: &sanitized_target,
        normalized_input: &normalized_input,
    })?;
    Ok(Resolved {
        identity,
        normalized_target,
        normalized_input,
    })
}

pub(super) fn build_identity(parts: IdentityParts<'_>) -> EffectResult<EffectIdentity> {
    let input_sha256 = digest(&stable(parts.normalized_input)?);
    let target_sha256 = digest(parts.normalized_target);
    let occurrence_sha256 = if parts.binding == PlanBinding::AcceptedPlan {
        let value = parts.occurrence.unwrap_or("");
        required(value, "runtime effect occurrence")?;
        Some(digest(butler_core::public_text::trim_js_whitespace(value)))
    } else {
        None
    };
    let base = butler_core::json::json_object!({"version":1,"workId":parts.work_id,"planRevisionId":parts.plan_revision_id,
        "actionKey":parts.action_key,"capability":parts.capability,"targetSha256":target_sha256,
        "inputSha256":input_sha256});
    let mut identity_body = base.clone();
    let mut slot_body = base;
    slot_body.remove("inputSha256");
    if let Some(sha) = occurrence_sha256.as_deref() {
        identity_body.insert("occurrenceSha256".into(), json!(sha));
        slot_body.remove("targetSha256");
        slot_body.insert("occurrenceSha256".into(), json!(sha));
    }
    let identity_sha256 = digest(&stable(&Value::Object(identity_body))?);
    let effect_id = format!(
        "guided-effect-{}",
        digest(&stable(&Value::Object(slot_body))?)
    );
    let request_sha256 = digest(&stable(&json!({"capability":parts.capability,
        "normalizedTarget":parts.normalized_target,"normalizedInput":parts.normalized_input}))?);
    Ok(EffectIdentity {
        effect_id,
        receipt_id: format!("guided-effect-receipt-{identity_sha256}"),
        idempotency_key: format!("guided-effect-idempotency-{identity_sha256}"),
        identity_sha256,
        request_sha256,
        input_sha256,
        target_sha256,
        work_id: parts.work_id.to_owned(),
        plan_revision_id: parts.plan_revision_id.to_owned(),
        action_key: parts.action_key.to_owned(),
        capability: parts.capability.to_owned(),
        sanitized_target: parts.sanitized_target.to_owned(),
    })
}
