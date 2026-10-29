use rusqlite::Connection;

pub(super) fn upgrade(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("DROP INDEX IF EXISTS canon_proposals_open;")?;
    let migrated: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('canon_proposals') WHERE name='source')",
        [],
        |r| r.get(0),
    )?;
    if migrated {
        return Ok(());
    }
    // Keep the original table name (and therefore its primary-key autoindex).
    // Capture every explicit index before rebuilding, including downstream indexes.
    let indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='canon_proposals' AND sql IS NOT NULL")?
        .query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    db.execute_batch("ALTER TABLE canon_proposals RENAME TO canon_proposals_old;")?;
    // The old indexes still own their names until the old table is dropped.
    db.execute_batch(
        include_str!("proposals.sql")
            .split("CREATE INDEX")
            .next()
            .unwrap_or_default(),
    )?;
    db.execute_batch("INSERT INTO canon_proposals(id,session_id,source_turn_id,source_call_id,project_id,summary,changes_json,state,resolved_by,created_at,resolved_at)
        SELECT id,session_id,source_turn_id,source_call_id,project_id,summary,changes_json,state,resolved_by,created_at,resolved_at FROM canon_proposals_old;
        DROP TABLE canon_proposals_old;")?;
    for index in indexes {
        db.execute_batch(&index)?;
    }
    db.execute_batch(include_str!("proposals.sql"))
}
