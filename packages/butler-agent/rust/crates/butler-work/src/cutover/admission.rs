//! Pending managed-message receipts. Tier 0 never enters this admission port.
use super::{import::stable_id, sql};
use crate::store::{self, Error, Result, Transaction};
use rusqlite::params;

#[derive(Debug, Clone)]
pub struct ManagedAdmission {
    pub message_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub body: String,
    pub received_seq: i64,
    // Passthrough: the authenticated sender identity of the original receipt.
    pub sender: serde_json::Value,
}

/// Persists the original message and Turn anchor without inventing a Task.
/// The runtime retains this receipt while waiting for the single epoch switch.
pub fn accept(tx: &Transaction<'_>, input: &ManagedAdmission) -> Result<String> {
    if input.message_id.is_empty() || input.session_id.is_empty() || input.turn_id.is_empty() {
        return Err(Error::Invalid(
            "managed admission requires original message/session/turn identities",
        ));
    }
    let hash = store::put_body(tx, &input.body)?;
    let id = stable_id("instruction", &input.message_id, "");
    tx.execute(
        sql::ADMIT,
        params![
            id,
            input.message_id,
            input.session_id,
            input.sender.to_string(),
            hash,
            input.turn_id,
            input.received_seq
        ],
    )?;
    let stored = tx.query_row(sql::ADMISSION_RECEIPT, [&input.message_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    if stored.1 != input.session_id || stored.2 != input.turn_id || stored.3 != hash {
        return Err(Error::Invalid("message receipt identity changed"));
    }
    Ok(stored.0)
}

/// A successful structured batch consumes its pending admission in that same
/// transaction. Replayed batches cannot regress or duplicate this receipt.
pub fn applied(tx: &Transaction<'_>, instruction: &str, session: &str) -> Result<()> {
    tx.execute(sql::ADMISSION_APPLIED, params![instruction, session])?;
    Ok(())
}
