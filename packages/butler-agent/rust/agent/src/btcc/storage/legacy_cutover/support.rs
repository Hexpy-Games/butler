use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use super::{LegacyTurn, digest, stable_json};
use crate::btcc::storage::migration::{column_exists, table_exists};
use crate::btcc::storage::{StorageError, StorageResult};

pub(super) struct ExistingOutbox {
    outbox_id: String,
    payload_id: String,
    payload_sha: String,
    message_id: String,
    content: String,
    pub(super) status: String,
}
pub(super) struct Delivery {
    pub(super) outbox_id: String,
    pub(super) payload_id: String,
    pub(super) payload_sha: String,
    pub(super) message_id: String,
    pub(super) content: String,
    pub(super) payload_json: String,
}

impl Delivery {
    pub(super) fn from_existing(value: &ExistingOutbox, turn_id: &str) -> StorageResult<Self> {
        let payload = payload(
            turn_id,
            &value.content,
            &value.payload_id,
            &value.payload_sha,
        )?;
        Ok(Self {
            outbox_id: value.outbox_id.clone(),
            payload_id: value.payload_id.clone(),
            payload_sha: value.payload_sha.clone(),
            message_id: value.message_id.clone(),
            content: value.content.clone(),
            payload_json: payload,
        })
    }
    pub(super) fn with_message(mut self, message_id: &str) -> Self {
        self.message_id = message_id.to_owned();
        self
    }
}

pub(super) fn new_delivery(turn_id: &str, revision: i64, content: &str, prefix: &str) -> Delivery {
    let content_sha = digest(content);
    let body = json!({"turnId": turn_id, "contentSha256": content_sha,
        "route": "assisted", "disposition": "completed", "content": content});
    let body_json = stable_json(&body).expect("finite static delivery JSON");
    let payload_sha = digest(&body_json);
    let payload_id = digest(&format!("btcc-payload.v1\0{payload_sha}"));
    let outbox_id = digest(&format!("{prefix}\0{turn_id}\0{revision}\0{payload_sha}"));
    let message_id = digest(&format!("btcc-assistant-message.v1\0{outbox_id}"));
    let payload_json =
        payload(turn_id, content, &payload_id, &payload_sha).expect("finite static delivery JSON");
    Delivery {
        outbox_id,
        payload_id,
        payload_sha,
        message_id,
        content: content.to_owned(),
        payload_json,
    }
}

pub(super) fn payload(turn_id: &str, content: &str, id: &str, sha: &str) -> StorageResult<String> {
    stable_json(&json!({"ref": {"id": id, "sha256": sha}, "turnId": turn_id,
        "contentSha256": digest(content), "route": "assisted", "disposition": "completed",
        "content": content}))
}

pub(super) fn insert_delivery(
    db: &Connection,
    turn_id: &str,
    revision: i64,
    value: &Delivery,
    status: &str,
) -> StorageResult<()> {
    db.execute(
        "INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json) \
        VALUES (?1, 'final_payload', ?2, ?3)",
        params![value.payload_id, value.payload_sha, value.payload_json],
    )
    .map_err(StorageError::sqlite)?;
    db.execute(
        "INSERT INTO btcc_delivery_outbox (outbox_id, turn_id, committed_turn_revision, \
        payload_id, payload_sha256, expected_message_id, content, status) VALUES \
        (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            value.outbox_id,
            turn_id,
            revision,
            value.payload_id,
            value.payload_sha,
            value.message_id,
            value.content,
            status
        ],
    )
    .map_err(StorageError::sqlite)?;
    Ok(())
}

pub(super) fn deactivate_runtime(db: &Connection, turn_id: &str) -> StorageResult<()> {
    db.execute(
        "UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL \
        WHERE turn_id = ?1 AND is_active = 1",
        [turn_id],
    )
    .map_err(StorageError::sqlite)?;
    db.execute(
        "UPDATE btcc_state_claims SET status = 'consumed' WHERE turn_id = ?1 \
        AND status != 'consumed'",
        [turn_id],
    )
    .map_err(StorageError::sqlite)?;
    Ok(())
}

pub(super) fn close_legacy_runtime(db: &Connection, turn_id: &str, at: &str) -> StorageResult<()> {
    deactivate_runtime(db, turn_id)?;
    if table_exists(db, "btcc_operational_interruptions").map_err(StorageError::sqlite)? {
        db.execute(
            "UPDATE btcc_operational_interruptions SET status = 'resolved', \
            resolved_at = COALESCE(resolved_at, ?1) WHERE turn_id = ?2 \
            AND status IN ('interrupted', 'ready')",
            params![at, turn_id],
        )
        .map_err(StorageError::sqlite)?;
    }
    if table_exists(db, "btcc_ledger_contentions").map_err(StorageError::sqlite)? {
        db.execute(
            "UPDATE btcc_ledger_contentions SET status = 'closed' WHERE turn_id = ?1 \
            AND status != 'closed'",
            [turn_id],
        )
        .map_err(StorageError::sqlite)?;
    }
    Ok(())
}

pub(super) fn load_turns(db: &Connection) -> StorageResult<Vec<LegacyTurn>> {
    let optional = |name: &str| -> StorageResult<String> {
        Ok(
            if column_exists(db, "btcc_turns", name).map_err(StorageError::sqlite)? {
                name.to_owned()
            } else {
                format!("NULL AS {name}")
            },
        )
    };
    let query = format!(
        "SELECT turn_id, session_id, original_message, semantic_state, revision, \
        execution_fence, active_checkpoint_id, route, {}, {}, final_payload_json, {}, {}, \
        delivery_outbox_id, canonical_assistant_message_id, final_disposition FROM btcc_turns \
        ORDER BY turn_id",
        optional("opening_answer_json")?,
        optional("managed_state_json")?,
        optional("goal_contract_ref")?,
        optional("final_dossier_ref")?
    );
    let mut statement = db.prepare(&query).map_err(StorageError::sqlite)?;
    statement
        .query_map([], |row| {
            Ok(LegacyTurn {
                turn_id: row.get(0)?,
                session_id: row.get(1)?,
                original_message: row.get(2)?,
                state: row.get(3)?,
                revision: row.get(4)?,
                fence: row.get(5)?,
                checkpoint_id: row.get(6)?,
                route: row.get(7)?,
                opening_answer: row.get(8)?,
                managed_state: row.get(9)?,
                final_payload: row.get(10)?,
                goal_contract_ref: row.get(11)?,
                final_dossier_ref: row.get(12)?,
                outbox_id: row.get(13)?,
                canonical_message_id: row.get(14)?,
                final_disposition: row.get(15)?,
            })
        })
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::sqlite)
}

pub(super) fn evidence_turn_ids(db: &Connection) -> StorageResult<BTreeSet<String>> {
    let mut statement = db
        .prepare("SELECT turn_id FROM btcc_r3_legacy_turn_cutovers ORDER BY turn_id")
        .map_err(StorageError::sqlite)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(StorageError::sqlite)
}

pub(super) fn has_delivery_authority(db: &Connection, turn: &LegacyTurn) -> StorageResult<bool> {
    if turn.outbox_id.is_some() || turn.canonical_message_id.is_some() {
        return Ok(true);
    }
    Ok(db
        .query_row(
            "SELECT 1 FROM btcc_delivery_outbox WHERE turn_id = ?1 LIMIT 1",
            [&turn.turn_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some())
}

pub(super) fn load_outbox(db: &Connection, turn_id: &str) -> StorageResult<Option<ExistingOutbox>> {
    db.query_row(
        "SELECT outbox_id, payload_id, payload_sha256, expected_message_id, content, status \
        FROM btcc_delivery_outbox WHERE turn_id = ?1",
        [turn_id],
        |row| {
            Ok(ExistingOutbox {
                outbox_id: row.get(0)?,
                payload_id: row.get(1)?,
                payload_sha: row.get(2)?,
                message_id: row.get(3)?,
                content: row.get(4)?,
                status: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(StorageError::sqlite)
}

pub(super) fn existing_canonical(
    db: &Connection,
    turn: &LegacyTurn,
    outbox: Option<&ExistingOutbox>,
) -> StorageResult<Option<String>> {
    for id in [
        turn.canonical_message_id.as_deref(),
        outbox.map(|row| row.message_id.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        let role = db
            .query_row(
                "SELECT role FROM btcc_messages WHERE message_id = ?1 AND turn_id = ?2",
                params![id, turn.turn_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StorageError::sqlite)?;
        if role.as_deref() == Some("assistant") {
            return Ok(Some(id.to_owned()));
        }
    }
    Ok(None)
}

pub(super) fn active_ids(
    db: &Connection,
    table: &str,
    id: &str,
    turn_id: &str,
    condition: &str,
) -> StorageResult<Vec<String>> {
    if !table_exists(db, table).map_err(StorageError::sqlite)? {
        return Ok(Vec::new());
    }
    let mut statement = db
        .prepare(&format!(
            "SELECT {id} FROM {table} WHERE turn_id = ?1 \
        AND {condition} ORDER BY {id}"
        ))
        .map_err(StorageError::sqlite)?;
    statement
        .query_map([turn_id], |row| row.get(0))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::sqlite)
}

pub(super) fn current_timestamp(db: &Connection) -> StorageResult<String> {
    db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
        row.get(0)
    })
    .map_err(StorageError::sqlite)
}

pub(super) fn optional_digest(value: Option<&str>) -> Option<String> {
    value.map(digest)
}

pub(super) fn limitation_message(original: &str) -> String {
    if original.chars().any(|value| ('가'..='힣').contains(&value)) {
        "이 요청은 이전 BTCC 실행에서 중단되었습니다. 이전 실행의 도구나 외부 효과를 자동으로 반복하지 않았습니다. 새 메시지로 이어서 요청하시면 저장된 Work와 확인된 결과를 바탕으로 계속 진행하겠습니다."
    } else {
        "This request stopped in the previous BTCC runtime. I did not automatically repeat its tools or external effects. Send a new message to continue from the saved Work and verified results."
    }.to_owned()
}
