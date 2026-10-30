//! Script15 prefix/term search and keyset pages; no App event/transcript scans.
use super::{AppHistoryQuery, AppStorageError};
use butler_core::search_text::analyze_search_query;
use rusqlite::{Connection, params, types::Value as Sql};
use serde_json::{Value, json};
const SQL: fn(rusqlite::Error) -> AppStorageError = AppStorageError::sqlite;
pub(super) fn terms(text: &str) -> String {
    let text = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))
        .unwrap_or(text);
    analyze_search_query(text)
        .split(" OR ")
        .filter(|s| !s.is_empty())
        .map(|s| format!("{s}*"))
        .collect::<Vec<_>>()
        .join(" OR ")
}
pub(super) fn page(db: &Connection, q: &AppHistoryQuery) -> Result<Value, AppStorageError> {
    let search = terms(&q.search);
    if !q.search.trim().is_empty() && search.is_empty() {
        return Ok(json!({"items":[],"next_cursor":null}));
    }
    let mut clauses = Vec::new();
    let mut args = Vec::<Sql>::new();
    let mut push = |clause: &str, value: Sql| {
        clauses.push(clause.to_owned());
        args.push(value);
    };
    if !search.is_empty() {
        push(
            "h.id IN (SELECT rowid FROM browser_history_visit_fts WHERE browser_history_visit_fts MATCH ?)",
            search.into(),
        );
    }
    if q.butler_only {
        clauses.push("h.butler_driven=1".into());
    }
    if let Some(since) = q.since {
        clauses.push("h.visited_at>=?".into());
        args.push(since.into());
    }
    if let Some(until) = q.until {
        clauses.push("h.visited_at<=?".into());
        args.push(until.into());
    }
    if let Ok((time, id)) = serde_json::from_str::<(i64, i64)>(&q.cursor) {
        clauses.push("(h.visited_at,h.id)<(?,?)".into());
        args.extend([time.into(), id.into()]);
    }
    let limit = q.limit.clamp(1, 60);
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let mut statement = db.prepare(&format!("SELECT h.id,h.url,h.title,h.favicon,h.visited_at,h.transition,h.tab_kind,h.conversation_id,h.butler_driven,h.source FROM browser_history h{where_sql} ORDER BY h.visited_at DESC,h.id DESC LIMIT {}",limit+1)).map_err(SQL)?;
    let mut items = statement
        .query_map(rusqlite::params_from_iter(args), row)
        .map_err(SQL)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SQL)?;
    let more = items.len() > limit;
    items.truncate(limit);
    let cursor = more
        .then(|| {
            items
                .last()
                .map(|v| json!([v["visitTime"], v["id"]]).to_string())
        })
        .flatten();
    Ok(json!({"items":items,"next_cursor":cursor}))
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let time = r.get::<_, i64>(4)?;
    Ok(
        json!({"id":r.get::<_,i64>(0)?,"url":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"favicon":r.get::<_,String>(3)?,
        "visitTime":time,"visitedAt":chrono::DateTime::from_timestamp_millis(time).map(|t|t.to_rfc3339()),
        "transition":r.get::<_,String>(5)?,"tabKind":r.get::<_,String>(6)?,"conversationId":r.get::<_,Option<String>>(7)?,
        "butlerDriven":r.get::<_,bool>(8)?,"source":r.get::<_,String>(9)?}),
    )
}
pub(super) fn suggestions(db: &Connection, search: &str) -> Result<Value, AppStorageError> {
    let search = terms(search);
    if search.is_empty() {
        return Ok(json!({"items":[]}));
    }
    let now = chrono::Utc::now().timestamp_millis();
    // Only indexed matches are ranked. Bookmark-only URLs get one visit's weight.
    let mut statement = db.prepare("WITH candidates AS (
        SELECT u.url,u.title,u.favicon,u.visits,u.last_visit,NULL AS bookmark_id
        FROM browser_history_fts JOIN browser_history_url u ON u.id=browser_history_fts.rowid WHERE browser_history_fts MATCH ?1
        UNION ALL SELECT l.url,l.title,'',coalesce(u.visits,1),coalesce(u.last_visit,cast((julianday(l.created_at)-2440587.5)*86400000 AS INTEGER)),l.id
        FROM browser_library_fts JOIN browser_library l ON l.rowid=browser_library_fts.rowid
        LEFT JOIN browser_history_url u ON u.url=l.url WHERE browser_library_fts MATCH ?1 AND l.kind='bookmark'),
        ranked AS (SELECT *,visits/(1.0+max(0,?2-last_visit)/86400000.0) AS score FROM candidates)
        SELECT url,title,favicon,visits,last_visit,bookmark_id,score FROM ranked
        WHERE bookmark_id IS NOT NULL OR url NOT IN (SELECT url FROM ranked WHERE bookmark_id IS NOT NULL)
        ORDER BY score DESC,last_visit DESC,url LIMIT 10").map_err(SQL)?;
    let items = statement.query_map(params![search,now], |r| Ok(json!({"url":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"favicon":r.get::<_,String>(2)?,"visits":r.get::<_,i64>(3)?,"lastVisit":r.get::<_,i64>(4)?,"bookmarkId":r.get::<_,Option<String>>(5)?,"score":r.get::<_,f64>(6)?}))).map_err(SQL)?.collect::<Result<Vec<_>,_>>().map_err(SQL)?;
    Ok(json!({"items":items}))
}
