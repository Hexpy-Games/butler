use super::*;

pub(crate) fn epic_deleted(tx: &Transaction<'_>, ctx: &Context, epic: &str) -> Result<()> {
    let owners = rows(
        tx,
        "SELECT session_id FROM canon_session_queue WHERE epic_id=?1 UNION SELECT session_id FROM canon_session_queue WHERE held_by_epic_id=?1",
        [epic],
    )?;
    for owner in owners {
        let session = text(&owner, "session_id")?;
        if let Some(item) = rows(tx, sql::ITEM, params![session, epic])?.first() {
            if item["state"] == "removed" {
                tx.execute(sql::DELETE_ITEM, params![session, epic])?;
            } else {
                operations::remove(tx, session, epic, false)?;
            }
        }
        tx.execute("UPDATE canon_session_queue SET state=CASE WHEN state='held' THEN 'waiting' ELSE state END,hold_reason=NULL,held_by_epic_id=NULL WHERE session_id=?1 AND held_by_epic_id=?2", params![session,epic])?;
        tx.execute("DELETE FROM canon_session_queue_chains WHERE session_id=?1 AND NOT EXISTS(SELECT 1 FROM canon_session_queue q WHERE q.session_id=?1 AND q.chain_id=canon_session_queue_chains.chain_id)", [session])?;
        changed(tx, ctx, session)?;
        engine::ready(tx, ctx, session)?;
    }
    Ok(())
}
