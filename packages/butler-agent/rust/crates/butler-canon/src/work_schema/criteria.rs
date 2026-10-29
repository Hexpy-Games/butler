use rusqlite::Connection;

pub(super) fn upgrade(db: &Connection) -> rusqlite::Result<()> {
    let definition: String = db.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='canon_activity'",
        [],
        |r| r.get(0),
    )?;
    if definition.contains("'criterion_confirmed'") {
        return Ok(());
    }
    let indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='canon_activity' AND sql IS NOT NULL")?
        .query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    db.execute_batch("ALTER TABLE canon_activity RENAME TO canon_activity_old;")?;
    db.execute_batch(
        include_str!("activity.sql")
            .split("CREATE INDEX")
            .next()
            .unwrap_or_default(),
    )?;
    db.execute_batch("INSERT INTO canon_activity SELECT * FROM canon_activity_old; DROP TABLE canon_activity_old;")?;
    for index in indexes {
        db.execute_batch(&index)?;
    }
    db.execute_batch(include_str!("activity.sql"))
}
