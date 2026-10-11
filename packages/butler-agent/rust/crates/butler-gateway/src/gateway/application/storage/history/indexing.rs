//! Refresh URL search terms in indexed batches, reusing the latest visit's analysis.
use super::AppStorageError;
use butler_memory::cognition::analyze_search_field;
use rusqlite::{Connection, params, params_from_iter};
use std::collections::BTreeSet;
const SQL: fn(rusqlite::Error) -> AppStorageError = AppStorageError::sqlite;

pub(super) fn summaries(db: &Connection, urls: BTreeSet<String>) -> Result<(), AppStorageError> {
    let urls: Vec<_> = urls.into_iter().collect();
    let mut delete = db
        .prepare_cached("DELETE FROM browser_history_fts WHERE rowid=?1")
        .map_err(SQL)?;
    let mut insert = db
        .prepare_cached("INSERT INTO browser_history_fts(rowid,terms) VALUES(?1,?2)")
        .map_err(SQL)?;
    for chunk in urls.chunks(500) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut query = db.prepare(&format!("SELECT s.id,s.title,s.url,v.terms FROM browser_history_url s LEFT JOIN browser_history h ON h.url=s.url AND h.visited_at=s.last_visit LEFT JOIN browser_history_visit_fts v ON v.rowid=h.id WHERE s.url IN ({placeholders})")).map_err(SQL)?;
        let rows = query
            .query_map(params_from_iter(chunk.iter()), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(SQL)?;
        for row in rows {
            let (id, title, url, terms) = row.map_err(SQL)?;
            let terms = terms.unwrap_or_else(|| analyze_search_field(&format!("{title} {url}")));
            delete.execute([id]).map_err(SQL)?;
            insert.execute(params![id, terms]).map_err(SQL)?;
        }
    }
    Ok(())
}
