use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::contracts::{EffectFailure, EffectIdentity, EffectResult, ExecuteEffect, PlanBinding};

pub(super) struct Resolved {
    pub identity: EffectIdentity,
    pub normalized_target: String,
    pub normalized_input: Value,
}

pub(super) struct IdentityParts<'a> {
    pub work_id: &'a str,
    pub plan_revision_id: &'a str,
    pub action_key: &'a str,
    pub binding: PlanBinding,
    pub occurrence: Option<&'a str>,
    pub capability: &'a str,
    pub normalized_target: &'a str,
    pub sanitized_target: &'a str,
    pub normalized_input: &'a Value,
}

pub(super) fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(crate) fn accepted_plan_effect_id(
    work_id: &str,
    plan_revision_id: &str,
    capability: &str,
    occurrence_id: &str,
) -> EffectResult<String> {
    let occurrence = crate::public_text::trim_js_whitespace(occurrence_id);
    required(occurrence, "runtime occurrence")?;
    let slot = json!({"version":1,"workId":work_id,"planRevisionId":plan_revision_id,
        "actionKey":"accepted-plan","capability":capability,
        "occurrenceSha256":digest(occurrence)});
    Ok(format!("guided-effect-{}", digest(&stable(&slot)?)))
}

pub(crate) fn effect_input_sha256(value: &Value) -> EffectResult<String> {
    Ok(digest(&stable(value)?))
}

pub(super) fn stable(value: &Value) -> EffectResult<String> {
    crate::json::stringify_sorted(value, &|left, right| {
        left.encode_utf16().cmp(right.encode_utf16())
    })
    .map_err(|error| EffectFailure::policy("effect_request_invalid", error.to_string()))
}

fn required(value: &str, label: &str) -> EffectResult<()> {
    if crate::public_text::trim_js_whitespace(value).is_empty() {
        Err(EffectFailure::policy(
            "effect_request_invalid",
            format!("Effect {label} must not be empty"),
        ))
    } else {
        Ok(())
    }
}
fn invalid(error: EffectFailure) -> EffectFailure {
    EffectFailure::policy("effect_request_invalid", error.message)
}

/// Resolve the reviewed action using the same policy as durable Effects.
pub(crate) fn reviewed_effect_action_key(
    work: &crate::btcc::WorkView,
    adapter: &dyn super::contracts::EffectAdapter,
    target: &str,
) -> EffectResult<String> {
    let normalized = adapter.normalize_target(target).map_err(invalid)?;
    let actions = work
        .current_plan
        .as_ref()
        .map(|plan| plan.actions.as_slice())
        .unwrap_or(&[]);
    action_key(actions, adapter, &normalized)
}

fn action_key(
    actions: &[crate::btcc::PlanAction],
    adapter: &dyn super::contracts::EffectAdapter,
    normalized_target: &str,
) -> EffectResult<String> {
    Ok(match adapter.binding() {
        PlanBinding::AcceptedPlan => {
            if !actions.iter().any(|action| action.effect.is_some()) {
                return Err(EffectFailure::policy(
                    "effect_action_not_found",
                    "The accepted Plan must mark at least one high-level persistent effect action before this change.",
                ));
            }
            "accepted-plan".to_owned()
        }
        PlanBinding::ExactAction => {
            let mut found = None;
            for action in actions {
                let Some(effect) = action.effect.as_ref() else {
                    continue;
                };
                if effect.get("capability").and_then(Value::as_str) != Some(adapter.capability()) {
                    continue;
                }
                let action_target = effect.get("target").and_then(Value::as_str).unwrap_or("");
                if adapter.normalize_target(action_target).map_err(invalid)? == normalized_target {
                    if found.is_some() {
                        return Err(EffectFailure::policy(
                            "effect_action_ambiguous",
                            "More than one action in the reviewed current Plan matches this effect.",
                        ));
                    }
                    found = Some(action.action_key.clone());
                }
            }
            found.ok_or_else(|| EffectFailure::policy("effect_action_not_found",
                "No action in the reviewed current Plan matches this capability and exact target."))?
        }
    })
}

pub(super) fn resolve(input: &ExecuteEffect) -> EffectResult<Resolved> {
    let plan = input.work.current_plan.as_ref().ok_or_else(|| {
        EffectFailure::policy(
            "effect_work_plan_missing",
            "The current Work has no Plan to authorize this effect.",
        )
    })?;
    let accepted = input
        .work
        .latest_plan_review
        .as_ref()
        .is_some_and(|review| {
            review.verdict == crate::btcc::work::ReviewVerdict::Accept
                && review.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
        });
    if !accepted {
        return Err(EffectFailure::policy(
            "effect_plan_review_required",
            "The current Plan revision requires an accepted Plan Review before effects.",
        ));
    }
    let adapter = input.adapter.as_ref();
    required(adapter.capability(), "adapter capability")?;
    let normalized_target = adapter.normalize_target(&input.target).map_err(invalid)?;
    required(&normalized_target, "normalized target")?;
    let binding = adapter.binding();
    let action_key = action_key(&plan.actions, adapter, &normalized_target)?;
    let occurrence = if binding == PlanBinding::AcceptedPlan {
        let value = input.occurrence_id.as_deref().unwrap_or("");
        required(value, "runtime effect occurrence")?;
        Some(crate::public_text::trim_js_whitespace(value))
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
        plan_revision_id: &plan.plan_revision_id,
        action_key: &action_key,
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
        Some(digest(crate::public_text::trim_js_whitespace(value)))
    } else {
        None
    };
    let base = crate::json::json_object!({"version":1,"workId":parts.work_id,"planRevisionId":parts.plan_revision_id,
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
