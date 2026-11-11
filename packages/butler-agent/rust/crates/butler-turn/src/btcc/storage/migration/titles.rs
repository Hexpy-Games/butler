//! Older builds stored an English placeholder as the card title when the
//! model gave none; the title comes from the task itself.
use rusqlite::{Connection, params};

/// The placeholders those builds stored.
const PLACEHOLDERS: [&str; 2] = ["Worker task", "Delegated task"];

pub(super) fn retitle_placeholder_cards(db: &Connection) -> rusqlite::Result<()> {
    if !super::table_exists(db, "btcc_session_relations")?
        || !super::table_exists(db, "btcc_subsession_delegations")?
    {
        return Ok(());
    }
    let rows = db
        .prepare(
            "SELECT r.relation_id, CASE WHEN json_valid(d.packet_json) \
             AND json_type(d.packet_json,'$.objective')='text' \
             THEN json_extract(d.packet_json,'$.objective') END \
             FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) \
             WHERE r.safe_title IN (?1,?2)",
        )?
        .query_map(params![PLACEHOLDERS[0], PLACEHOLDERS[1]], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (relation, objective) in rows {
        let title =
            butler_core::public_text::delegation_title(None, objective.as_deref().unwrap_or(""));
        if !title.is_empty() {
            db.execute(
                "UPDATE btcc_session_relations SET safe_title=?2 WHERE relation_id=?1",
                params![relation, title],
            )?;
        }
    }
    Ok(())
}
