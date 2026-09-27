use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::btcc::effects::contracts::*;

fn sql(error: rusqlite::Error) -> EffectFailure {
    EffectFailure::storage("sqlite_error", error.to_string()).with_source(error)
}

struct Raw {
    blocker_id: String,
    source_turn_id: String,
    source_occurrence_id: String,
    work_id: String,
    capability: String,
    target: String,
    input_json: String,
    input_sha256: String,
    idempotency_key: String,
    detail: String,
    status: String,
    resolution_json: Option<String>,
    created_at: String,
}
fn raw(row: &Row<'_>) -> rusqlite::Result<Raw> {
    Ok(Raw {
        blocker_id: row.get(0)?,
        source_turn_id: row.get(1)?,
        source_occurrence_id: row.get(2)?,
        work_id: row.get(3)?,
        capability: row.get(4)?,
        target: row.get(5)?,
        input_json: row.get(6)?,
        input_sha256: row.get(7)?,
        idempotency_key: row.get(8)?,
        detail: row.get(9)?,
        status: row.get(10)?,
        resolution_json: row.get(11)?,
        created_at: row.get(12)?,
    })
}
/// A stored blocker with its input verified against its digest and a
/// resolution consistent with its status.
fn hydrate(row: Raw) -> EffectResult<EffectBlocker> {
    let corrupt = |what: &str| {
        EffectFailure::storage(
            "effect_blocker_corrupt",
            format!("{what}: {}", row.blocker_id),
        )
    };
    let digest = format!("{:x}", Sha256::digest(row.input_json.as_bytes()));
    if digest != row.input_sha256 {
        return Err(corrupt("Guided Work effect blocker input is corrupted"));
    }
    let input: Value = serde_json::from_str(&row.input_json).map_err(|error| {
        EffectFailure::storage("effect_blocker_json", error.to_string()).with_source(error)
    })?;
    if !input.is_object() {
        return Err(corrupt("Guided Work effect blocker input is invalid"));
    }
    let status = BlockerStatus::parse(&row.status).ok_or_else(|| {
        EffectFailure::storage("effect_blocker_corrupt", "invalid blocker status")
    })?;
    let consistent = match status {
        BlockerStatus::Unresolved => row.resolution_json.is_none(),
        BlockerStatus::Applied => resolved_applied(row.resolution_json.as_deref())?,
    };
    if !consistent {
        return Err(corrupt(match status {
            BlockerStatus::Unresolved => "Unresolved Guided Work blocker has a resolution",
            BlockerStatus::Applied => "Guided Work blocker resolution is invalid",
        }));
    }
    Ok(EffectBlocker {
        blocker_id: row.blocker_id,
        source_turn_id: row.source_turn_id,
        source_occurrence_id: row.source_occurrence_id,
        work_id: row.work_id,
        capability: row.capability,
        target: row.target,
        input,
        input_sha256: row.input_sha256,
        idempotency_key: row.idempotency_key,
        detail: row.detail,
        resolution: (status == BlockerStatus::Applied).then(|| "applied".into()),
        status,
        created_at: row.created_at,
    })
}

/// Whether an applied blocker's stored resolution records `status: applied`.
fn resolved_applied(resolution_json: Option<&str>) -> EffectResult<bool> {
    let resolution = resolution_json
        .filter(|text| !text.is_empty())
        .map(|text| {
            serde_json::from_str::<Value>(text).map_err(|error| {
                EffectFailure::storage("effect_blocker_json", error.to_string()).with_source(error)
            })
        })
        .transpose()?;
    Ok(resolution
        .as_ref()
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        == Some("applied"))
}
pub(super) fn list(db: &Connection, work_id: &str) -> EffectResult<Vec<EffectBlocker>> {
    let mut statement = db.prepare("SELECT blocker_id,source_turn_id,source_occurrence_id,work_id,capability,target,
        input_json,input_sha256,idempotency_key,detail,status,resolution_json,created_at
        FROM btcc_guided_work_effect_blockers WHERE work_id=?1 AND status IN ('unresolved','applied')
        ORDER BY created_at,blocker_id").map_err(sql)?;
    statement
        .query_map([work_id], raw)
        .map_err(sql)?
        .map(|item| item.map_err(sql).and_then(hydrate))
        .collect()
}
pub(super) fn resolve(
    db: &mut Connection,
    work_id: &str,
    occurrence: &str,
    resolution: &str,
    clock: &dyn Fn() -> String,
) -> EffectResult<bool> {
    if !matches!(resolution, "applied" | "not_applied") {
        return Err(EffectFailure::policy(
            "effect_request_invalid",
            "invalid blocker resolution",
        ));
    }
    let tx = db.transaction().map_err(sql)?;
    let now = clock();
    let resolution_json = format!("{{\"status\":\"{resolution}\"}}");
    let updated = tx
        .execute(
            "UPDATE btcc_guided_work_effect_blockers SET status=?1,
        resolution_json=?2,resolved_at=?3 WHERE work_id=?4 AND source_occurrence_id=?5
        AND status='unresolved'",
            params![resolution, resolution_json, now, work_id, occurrence],
        )
        .map_err(sql)?;
    let remaining: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM btcc_guided_work_effect_blockers
        WHERE work_id=?1 AND status='unresolved' LIMIT 1",
            [work_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    if remaining.is_none() {
        tx.execute(
            "UPDATE btcc_guided_works SET status='open',updated_at=?1 WHERE work_id=?2
            AND status='blocked'",
            params![now, work_id],
        )
        .map_err(sql)?;
    }
    tx.commit().map_err(sql)?;
    Ok(updated > 0)
}
