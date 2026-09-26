use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::btcc::effects::contracts::*;

const SELECT: &str = "SELECT e.effect_id,e.receipt_id,e.idempotency_key,e.identity_sha256,
 e.request_sha256,e.input_sha256,e.target_sha256,e.work_id,e.plan_revision_id,e.action_key,
 e.capability,e.sanitized_target,e.status,e.journal_revision,e.dispatch_attempts,
 e.result_json,e.receipt_json,e.error_json,
 recovery.capability,recovery.start_line,recovery.before_sha256,recovery.after_sha256,
 payload.payload_json,e.created_at,e.updated_at FROM btcc_guided_effects e
 LEFT JOIN btcc_guided_effect_recovery_hints recovery ON recovery.effect_id=e.effect_id
 LEFT JOIN btcc_guided_effect_recovery_payloads payload ON payload.effect_id=e.effect_id";

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn sql(error: rusqlite::Error) -> EffectFailure {
    EffectFailure::storage("sqlite_error", error.to_string())
}
fn json(error: impl std::fmt::Display) -> EffectFailure {
    EffectFailure::storage("effect_journal_corrupt", error.to_string())
}

struct Raw {
    identity: EffectIdentity,
    status: String,
    journal_revision: i64,
    dispatch_attempts: i64,
    result_json: Option<String>,
    receipt_json: Option<String>,
    error_json: Option<String>,
    recovery_capability: Option<String>,
    recovery_start_line: Option<i64>,
    recovery_before: Option<String>,
    recovery_after: Option<String>,
    payload: Option<String>,
    created_at: String,
    updated_at: String,
}
fn raw(row: &Row<'_>) -> rusqlite::Result<Raw> {
    Ok(Raw {
        identity: EffectIdentity {
            effect_id: row.get(0)?,
            receipt_id: row.get(1)?,
            idempotency_key: row.get(2)?,
            identity_sha256: row.get(3)?,
            request_sha256: row.get(4)?,
            input_sha256: row.get(5)?,
            target_sha256: row.get(6)?,
            work_id: row.get(7)?,
            plan_revision_id: row.get(8)?,
            action_key: row.get(9)?,
            capability: row.get(10)?,
            sanitized_target: row.get(11)?,
        },
        status: row.get(12)?,
        journal_revision: row.get(13)?,
        dispatch_attempts: row.get(14)?,
        result_json: row.get(15)?,
        receipt_json: row.get(16)?,
        error_json: row.get(17)?,
        recovery_capability: row.get(18)?,
        recovery_start_line: row.get(19)?,
        recovery_before: row.get(20)?,
        recovery_after: row.get(21)?,
        payload: row.get(22)?,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
    })
}
fn hydrate(raw: Raw) -> EffectResult<EffectRecord> {
    let result: Option<crate::json::JsonDocument> = raw
        .result_json
        .map(|text| crate::json::JsonDocument::from_encoded(text).map_err(json))
        .transpose()?;
    let mut receipt: Option<EffectReceipt> = raw
        .receipt_json
        .as_deref()
        .map(|text| serde_json::from_str(text).map_err(json))
        .transpose()?;
    if let (Some(result), Some(receipt)) = (&result, receipt.as_mut())
        && result == &receipt.result
    {
        receipt.result = result.clone();
    }
    let error = raw
        .error_json
        .as_deref()
        .map(|text| serde_json::from_str(text).map_err(json))
        .transpose()?;
    let recovery_hint = if let Some(payload) = raw.payload {
        let value: serde_json::Value = serde_json::from_str(&payload).map_err(|_| {
            json(format!(
                "Guided edit batch recovery payload is invalid: {}",
                raw.identity.effect_id
            ))
        })?;
        Some(RecoveryHint::Batch {
            capability: "edit_file".into(),
            entries: crate::btcc::effects::recovery::normalize_entries(&value).map_err(
                |error| EffectFailure::storage("effect_recovery_corrupt", error.message),
            )?,
        })
    } else if let (Some(capability), Some(start_line), Some(before_sha256), Some(after_sha256)) = (
        raw.recovery_capability,
        raw.recovery_start_line,
        raw.recovery_before,
        raw.recovery_after,
    ) {
        Some(RecoveryHint::Single {
            capability,
            start_line,
            before_sha256,
            after_sha256,
        })
    } else {
        None
    };
    Ok(EffectRecord {
        identity: raw.identity,
        status: EffectStatus::parse(&raw.status)?,
        journal_revision: raw.journal_revision,
        dispatch_attempts: raw.dispatch_attempts,
        result,
        receipt,
        error,
        recovery_hint,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}
pub(super) fn find(db: &Connection, effect_id: &str) -> EffectResult<Option<EffectRecord>> {
    db.query_row(&format!("{SELECT} WHERE e.effect_id=?1"), [effect_id], raw)
        .optional()
        .map_err(sql)?
        .map(hydrate)
        .transpose()
}
pub(super) fn list_for_work(
    db: &Connection,
    work_id: &str,
    limit: Option<f64>,
) -> EffectResult<Vec<EffectRecord>> {
    let limit = limit.unwrap_or(12.0).trunc().clamp(1.0, 50.0) as i64;
    let mut statement = db
        .prepare(&format!(
            "{SELECT} WHERE e.work_id=?1 \
        ORDER BY e.updated_at DESC,e.effect_id DESC LIMIT ?2"
        ))
        .map_err(sql)?;
    statement
        .query_map(params![work_id, limit], raw)
        .map_err(sql)?
        .map(|item| item.map_err(sql).and_then(hydrate))
        .collect()
}
