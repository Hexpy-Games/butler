//! Reuse this transaction's latest visit analysis; older visits use indexed lookups.
use super::AppStorageError;
use butler_core::search_text::analyze_search_field;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use std::collections::BTreeMap;
const SQL: fn(rusqlite::Error) -> AppStorageError = AppStorageError::sqlite;

pub(super) type SummaryTerms = BTreeMap<String, Option<(i64, String)>>;

pub(super) fn remember(changed: &mut SummaryTerms, url: String, time: i64, terms: String) {
    let cached = changed.entry(url).or_default();
    if cached
        .as_ref()
        .is_none_or(|(previous, _)| time >= *previous)
    {
        *cached = Some((time, terms));
    }
}

pub(super) fn summaries(db: &Connection, changed: SummaryTerms) -> Result<(), AppStorageError> {
    let mut rows = Vec::with_capacity(changed.len());
    for chunk in changed.keys().collect::<Vec<_>>().chunks(500) {
        rows.extend(summary_rows(db, chunk, &changed)?);
    }
    // The writer has a small page cache. Finish reads, then stream each FTS write
    // in rowid order rather than alternating distant content/index pages.
    rows.sort_unstable_by_key(|(id, _)| *id);
    drop(changed);
    let mut delete = db
        .prepare_cached("DELETE FROM browser_history_fts WHERE rowid=?1")
        .map_err(SQL)?;
    let mut insert = db
        .prepare_cached("INSERT INTO browser_history_fts(rowid,terms) VALUES(?1,?2)")
        .map_err(SQL)?;
    for (id, _) in &rows {
        delete.execute([id]).map_err(SQL)?;
    }
    for (id, terms) in rows {
        insert.execute(params![id, terms]).map_err(SQL)?;
    }
    Ok(())
}

fn summary_rows(
    db: &Connection,
    urls: &[&String],
    changed: &SummaryTerms,
) -> Result<Vec<(i64, String)>, AppStorageError> {
    let placeholders = std::iter::repeat_n("?", urls.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut query = db
        .prepare(&format!(
            "SELECT id,title,url,last_visit FROM browser_history_url WHERE url IN ({placeholders})"
        ))
        .map_err(SQL)?;
    let rows = query
        .query_map(params_from_iter(urls.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(SQL)?;
    let mut indexed = Vec::with_capacity(urls.len());
    for row in rows {
        let (id, title, url, time) = row.map_err(SQL)?;
        let terms = match changed.get(&url).and_then(Option::as_ref) {
            Some((visited_at, terms)) if *visited_at == time => terms.clone(),
            _ => latest_terms(db, &url, &title, time)?,
        };
        indexed.push((id, terms));
    }
    Ok(indexed)
}

fn latest_terms(
    db: &Connection,
    url: &str,
    title: &str,
    time: i64,
) -> Result<String, AppStorageError> {
    let terms: Option<String> = db.prepare_cached("SELECT terms FROM browser_history_visit_fts WHERE rowid=(SELECT id FROM browser_history WHERE url=?1 AND visited_at=?2)").map_err(SQL)?.query_row(params![url, time], |r| r.get(0)).optional().map_err(SQL)?;
    Ok(terms.unwrap_or_else(|| analyze_search_field(&format!("{title} {url}"))))
}
