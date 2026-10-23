//! The writer commits a native tool's response with the mutations it describes.
use super::*;
use rusqlite::params;
use sha2::{Digest, Sha256};
mod rejection;

pub mod sql {
    pub const RECEIPT: &str = "SELECT payload_json FROM wm_audit WHERE entity_kind='work_apply' AND entity_id=?1 ORDER BY seq LIMIT 1";
    pub const ALL: &[(&str, &str)] = &[("APPLY_RECEIPT", RECEIPT)];
}
/// Runtime identities are outside the model payload. Identical retries return
/// the original response, including ids and revisions, without applying again.
pub fn apply_tool(
    tx: &Transaction<'_>,
    ctx: &Context,
    scope: &ApplyScope,
    call_id: &str,
    raw: &Value,
) -> Result<Value> {
    if call_id.is_empty() {
        return Err(Error::Invalid("tool call identity required"));
    }
    let request_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!({
            "session":scope.session_id,"turn":scope.turn_id,"instruction":scope.instruction_id,"input":raw,
        }))?)
    );
    if let Some(stored) = tx
        .query_row(sql::RECEIPT, [call_id], |r| r.get::<_, String>(0))
        .optional()?
    {
        let stored: Value = serde_json::from_str(&stored)?;
        return if stored["request_hash"] == request_hash {
            Ok(stored["response"].clone())
        } else {
            Ok(
                json!({"ok":false,"error":{"code":"idempotency_conflict","message":"Reuse an idempotency key only for the identical operation."}}),
            )
        };
    }
    let mut failed = None;
    let mut result = if forbidden_canon(raw) {
        Ok(rejection::canon())
    } else {
        match serde_json::from_value::<Apply>(raw.clone()) {
            Ok(input) => match check_ownership(tx, scope, &input)
                .and_then(|()| apply_with_context(tx, ctx, scope, &input, &mut failed))
            {
                Ok(value) => Ok(value),
                Err(Error::OwnedElsewhere { detail }) => {
                    ownership::ownership_prompt(tx, ctx, &scope.session_id, &detail)
                }
                Err(Error::Sqlite(error)) => Err(Error::Sqlite(error)),
                Err(Error::BodyCodec(error)) => Err(Error::BodyCodec(error)),
                Err(error) => rejection::response(tx, scope, &error, failed.as_ref()),
            },
            Err(error) => Ok(
                json!({"ok":false,"error":{"code":"work_apply_rejected","message":super::super::model_text::rejected(&error.to_string())}}),
            ),
        }
    }?;
    if result["ok"] == false && result.get("work").is_none() {
        result["work"] = scope
            .work_id
            .as_deref()
            .map(|id| read_work(tx, id))
            .transpose()?
            .unwrap_or(Value::Null);
    }
    let payload = json!({"request_hash":request_hash,"response":result});
    tx.execute(
        super::super::sql::AUDIT,
        params![
            "work_apply",
            call_id,
            0,
            ctx.actor.to_string(),
            "receipt",
            ctx.now,
            payload.to_string()
        ],
    )?;
    Ok(result)
}
fn forbidden_canon(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "visibility" | "canon_status" | "canon_status_source"
            ) || forbidden_canon(value)
        }),
        Value::Array(items) => items.iter().any(forbidden_canon),
        _ => false,
    }
}

fn check_ownership(db: &Connection, scope: &ApplyScope, input: &Apply) -> Result<()> {
    for op in &input.operations {
        if let Operation::Start { task_id } = op
            && !task_id.starts_with('@')
            && let Some(detail) = ownership::owned_elsewhere(db, task_id, &scope.session_id)?
        {
            return Err(Error::OwnedElsewhere { detail });
        }
    }
    Ok(())
}
