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
    inject_runtime_instruction(state, turn, instructions).await?;
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

async fn inject_runtime_instruction(
    state: &GuidedTextState,
    turn: &TurnRecord,
    instructions: &mut String,
) -> Result<(), BtccError> {
    let Some(id) = turn
        .context
        .get("runtimeInstructionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(());
    };
    let session = turn.session_id.clone();
    let row = state
        .journal
        .work_model_storage()
        .work_model_read(move |db| {
            use rusqlite::OptionalExtension;
            let row = db
                .query_row(
                    store::ownership_sql::RUNTIME_INSTRUCTION,
                    rusqlite::params![id, session],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            row.map(|(id, body, status)| {
                let value: Value = serde_json::from_str(&store::tool_read::body(db, &body)?)?;
                Ok((
                    id,
                    value["body"]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    status,
                ))
            })
            .transpose()
        })
        .await
        .map_err(BtccError::from)?;
    if let Some((id, text, status)) = row {
        if !instructions.ends_with(text.as_str()) {
            instructions.push('\n');
            instructions.push_str(&text);
        }
        if status == "waiting_for_task" {
            state
                .journal
                .work_model_storage()
                .work_model_write(move |tx| {
                    let ctx = store::Context {
                        now: chrono::Utc::now().timestamp_millis(),
                        actor: serde_json::json!({"runtime":"prompt"}),
                    };
                    store::deliver_instruction(tx, &ctx, &id, &status)?;
                    store::apply_instruction(tx, &ctx, &id)
                })
                .await
                .map_err(BtccError::from)?;
        }
    }
    Ok(())
}
