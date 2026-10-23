//! A postponed turn yields its receipt to exactly one replay execution.
use butler_core::json::at;
use butler_work::{cutover, store};
use rusqlite::{OptionalExtension, params};
use serde_json::json;

pub(crate) const RECEIPT: &str = "SELECT id,anchor_id,body_ref,status FROM wm_instructions WHERE idempotency_key=?1 AND target_session_id=?2";
pub(crate) const REPLAY_RECEIPT: &str =
    "SELECT id,anchor_id,body_ref,status FROM wm_instructions WHERE id=?1 AND target_session_id=?2";
pub(crate) const WAIT: &str = "SELECT 1 FROM wm_cross_db_intents WHERE op_id=?1";

pub(super) fn admit(
    tx: &store::Transaction<'_>,
    input: &cutover::ManagedAdmission,
) -> store::Result<(String, bool)> {
    let ctx = store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: json!({"runtime":"cutover"}),
    };
    let replay_receipt = input.message_id.strip_prefix("cutover-message:");
    let (query, identity) = replay_receipt.map_or((RECEIPT, input.message_id.as_str()), |id| {
        (REPLAY_RECEIPT, id)
    });
    let existing: Option<(String, String, String, String)> = tx
        .query_row(query, params![identity, input.session_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?;
    if let Some((id, anchor, hash, status)) = existing {
        if store::put_body(tx, &input.body)? != hash {
            return Err(store::Error::Invalid("message receipt identity changed"));
        }
        let kept = tx
            .query_row(WAIT, [format!("cutover_wait:{id}")], |_| Ok(()))
            .optional()?
            .is_some();
        if kept {
            let ready = replay_receipt.is_some() && replay(tx, &ctx, &id, &anchor, &status, input)?;
            return Ok((id, ready));
        }
    }
    let id = cutover::accept(tx, input)?;
    let ready = cutover::status(tx)?.state == cutover::CutoverState::Done;
    if !ready {
        store::record_intent(
            tx,
            &ctx,
            &format!("cutover_wait:{id}"),
            "cutover_wait",
            &json!({"instruction_id":id,"turn_id":input.turn_id}),
        )?;
    }
    Ok((id, ready))
}

fn replay(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    id: &str,
    anchor: &str,
    status: &str,
    input: &cutover::ManagedAdmission,
) -> store::Result<bool> {
    if input.turn_id == anchor
        || !matches!(status, "delivered" | "applied")
        || cutover::status(tx)?.state != cutover::CutoverState::Done
    {
        return Ok(false);
    }
    let op = format!("cutover_replay:{id}");
    let owner = json!({"turn_id":input.turn_id,"session_id":input.session_id});
    let intent = store::record_intent(tx, ctx, &op, "cutover_replay", &owner)?;
    let stored: serde_json::Value = serde_json::from_str(
        at(&intent, "/payload_json")
            .as_str()
            .ok_or(store::Error::Invalid("replay owner"))?,
    )?;
    if stored != owner {
        return Ok(false);
    }
    store::mark_intent_applied(
        tx,
        ctx,
        &op,
        at(&intent, "/revision")
            .as_i64()
            .ok_or(store::Error::Invalid("replay revision"))?,
    )?;
    Ok(true)
}
