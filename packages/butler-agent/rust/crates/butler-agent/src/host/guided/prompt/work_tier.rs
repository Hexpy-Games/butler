//! Re-evaluate the tier at each request, so escalation replaces the rule block.
use super::*;
use butler_turn::btcc::PolicyRole;
use butler_work::store;
pub(super) async fn configure(
    state: &GuidedTextState,
    turn: &TurnRecord,
    instructions: &mut String,
    cache_prefix: &mut Option<Value>,
) -> Result<bool, BtccError> {
    if state.phase.execution_policy.role != PolicyRole::Butler
        || !instructions.contains(store::TIER_ONE)
    {
        return Ok(false);
    }
    let session = turn.session_id.clone();
    let tier2 = state
        .journal
        .work_model_storage()
        .work_model_read(move |db| {
            Ok(store::bound_work(db, &session, None)?.is_some_and(|work| work["tier"] == 2))
        })
        .await
        .map_err(BtccError::from)?;
    if tier2 {
        *instructions = instructions.replace(store::TIER_ONE, store::TIER_TWO);
        if let Some(prefix) = cache_prefix.as_mut()
            && let Some(text) = prefix.get("instructionPrefix").and_then(Value::as_str)
        {
            prefix["instructionPrefix"] =
                Value::String(text.replace(store::TIER_ONE, store::TIER_TWO));
        }
        return Ok(true);
    }
    Ok(false)
}
