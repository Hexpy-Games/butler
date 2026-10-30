//! Visit-only batches and transactional deletion of visits, summaries and FTS.
use super::AppStorageError;
use butler_core::search_text::analyze_search_field;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::BTreeSet;
const SQL: fn(rusqlite::Error) -> AppStorageError = AppStorageError::sqlite;
pub(super) fn record(db: &Connection, visits: &[Value]) -> Result<Value, AppStorageError> {
    let mut insert = db.prepare_cached("INSERT OR IGNORE INTO browser_history(url,title,favicon,visited_at,transition,tab_kind,conversation_id,butler_driven,source) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)").map_err(SQL)?;
    let mut index = db
        .prepare_cached("INSERT INTO browser_history_visit_fts(rowid,terms) VALUES(?1,?2)")
        .map_err(SQL)?;
    let mut changed = super::indexing::SummaryTerms::new();
    let defer_index = visits.iter().all(|visit| visit["metadataOnly"] != true);
    let mut pending_index = Vec::new();
    let mut count = 0;
    for visit in visits {
        let Some((url, time)) = eligible(db, visit)? else {
            continue;
        };
        if visit["metadataOnly"] == true {
            metadata(db, &url, time, visit)?;
            if let Some(cached) = changed.get_mut(&url) {
                *cached = None;
            }
            continue;
        }
        let source = visit["source"].as_str().unwrap_or("butler");
        if source != "butler"
            && !source
                .strip_prefix("imported:")
                .is_some_and(|s| !s.is_empty() && s.len() <= 64)
        {
            continue;
        }
        let inserted = insert
            .execute(params![
                url,
                visit["title"].as_str().unwrap_or(&url),
                visit["favicon"].as_str().unwrap_or(""),
                time,
                visit["transition"].as_str().unwrap_or("link"),
                visit["tabKind"].as_str().unwrap_or("mine"),
                visit["conversationId"].as_str(),
                visit["butlerDriven"].as_bool().unwrap_or(false),
                source
            ])
            .map_err(SQL)?;
        if inserted > 0 {
            let terms =
                analyze_search_field(&format!("{} {url}", visit["title"].as_str().unwrap_or("")));
            if defer_index {
                pending_index.push((db.last_insert_rowid(), terms.clone()));
            } else {
                index
                    .execute(params![db.last_insert_rowid(), terms])
                    .map_err(SQL)?;
            }
            insert_summary(db, &url, time, visit)?;
            super::indexing::remember(&mut changed, url, time, terms);
            count += inserted;
        }
    }
    for (id, terms) in pending_index {
        index.execute(params![id, terms]).map_err(SQL)?;
    }
    super::indexing::summaries(db, changed)?;
    Ok(json!({"recorded":count}))
}
fn eligible(db: &Connection, visit: &Value) -> Result<Option<(String, i64)>, AppStorageError> {
    if visit["private"] == true {
        return Ok(None);
    }
    let Some(url) = visit["url"].as_str().and_then(|s| url::Url::parse(s).ok()) else {
        return Ok(None);
    };
    if !matches!(url.scheme(), "http" | "https")
        || ["/__p/", "/__o/"].iter().any(|p| url.path().starts_with(p))
    {
        return Ok(None);
    }
    let Some(time) = visit["visitedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    else {
        return Ok(None);
    };
    match visit["tabKind"].as_str() {
        Some("mine") if visit["background"] != true => {}
        Some("conversation") => {
            let id = visit["conversationId"].as_str().unwrap_or_default();
            let visible: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1 AND archived=0)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(SQL)?;
            if !visible {
                return Ok(None);
            }
        }
        _ => return Ok(None),
    }
    Ok(Some((url.to_string(), time.timestamp_millis())))
}
fn refresh(db: &Connection, url: &str) -> Result<(), AppStorageError> {
    let latest = db.query_row("SELECT title,favicon,visited_at FROM browser_history WHERE url=?1 ORDER BY visited_at DESC,id DESC LIMIT 1", [url], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).optional().map_err(SQL)?;
    let Some((title, favicon, time)) = latest else {
        db.execute("DELETE FROM browser_history_url WHERE url=?1", [url])
            .map_err(SQL)?;
        return Ok(());
    };
    db.execute("INSERT INTO browser_history_url(url,title,favicon,last_visit,visits) VALUES(?1,?2,?3,?4,(SELECT count(*) FROM browser_history WHERE url=?1)) ON CONFLICT(url) DO UPDATE SET title=excluded.title,favicon=excluded.favicon,last_visit=excluded.last_visit,visits=excluded.visits", params![url,title,favicon,time]).map_err(SQL)?;
    index_summary(db, url)
}
fn index_summary(db: &Connection, url: &str) -> Result<(), AppStorageError> {
    let title: String = db
        .query_row(
            "SELECT title FROM browser_history_url WHERE url=?1",
            [url],
            |r| r.get(0),
        )
        .map_err(SQL)?;
    let id: i64 = db
        .query_row(
            "SELECT id FROM browser_history_url WHERE url=?1",
            [url],
            |r| r.get(0),
        )
        .map_err(SQL)?;
    db.execute("DELETE FROM browser_history_fts WHERE rowid=?1", [id])
        .map_err(SQL)?;
    db.execute(
        "INSERT INTO browser_history_fts(rowid,terms) VALUES(?1,?2)",
        params![id, analyze_search_field(&format!("{title} {url}"))],
    )
    .map_err(SQL)?;
    Ok(())
}
pub(super) fn delete_ids(db: &Connection, ids: &[i64]) -> Result<Value, AppStorageError> {
    let mut urls = BTreeSet::new();
    let mut count = 0;
    for id in ids {
        let url: Option<String> = db
            .query_row("SELECT url FROM browser_history WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(SQL)?;
        if let Some(url) = url {
            urls.insert(url);
        }
        count += db
            .execute("DELETE FROM browser_history WHERE id=?1", [id])
            .map_err(SQL)?;
    }
    for url in urls {
        refresh(db, &url)?;
    }
    Ok(json!({"deleted":count}))
}
pub(super) fn delete_url(db: &Connection, url: &str) -> Result<Value, AppStorageError> {
    let count = db
        .execute("DELETE FROM browser_history WHERE url=?1", [url])
        .map_err(SQL)?;
    refresh(db, url)?;
    Ok(json!({"deleted":count}))
}
pub(super) fn clear(
    db: &Connection,
    since: Option<i64>,
    until: i64,
    only: bool,
) -> Result<Value, AppStorageError> {
    // An indexed range; affected URLs are refreshed once, within the same transaction.
    let condition = if only {
        "butler_driven=1 AND visited_at>=?1 AND visited_at<=?2"
    } else {
        "visited_at>=?1 AND visited_at<=?2"
    };
    let mut statement = db
        .prepare(&format!(
            "SELECT DISTINCT url FROM browser_history WHERE {condition}"
        ))
        .map_err(SQL)?;
    let urls = statement
        .query_map(params![since.unwrap_or(i64::MIN), until], |r| {
            r.get::<_, String>(0)
        })
        .map_err(SQL)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SQL)?;
    let count = db
        .execute(
            &format!("DELETE FROM browser_history WHERE {condition}"),
            params![since.unwrap_or(i64::MIN), until],
        )
        .map_err(SQL)?;
    for url in urls {
        refresh(db, &url)?;
    }
    Ok(json!({"deleted":count}))
}
/// Complete one committed visit, never recreating a deleted row.
fn metadata(db: &Connection, url: &str, time: i64, visit: &Value) -> Result<(), AppStorageError> {
    let title = visit["title"].as_str().unwrap_or(url);
    let favicon = visit["favicon"].as_str().unwrap_or("");
    let changed = db.execute("UPDATE browser_history SET title=?3,favicon=?4 WHERE url=?1 AND visited_at=?2 AND (title!=?3 OR favicon!=?4)",params![url,time,title,favicon]).map_err(SQL)?;
    if changed == 0 {
        return Ok(());
    }
    let id: i64 = db
        .query_row(
            "SELECT id FROM browser_history WHERE url=?1 AND visited_at=?2",
            params![url, time],
            |r| r.get(0),
        )
        .map_err(SQL)?;
    db.execute("DELETE FROM browser_history_visit_fts WHERE rowid=?1", [id])
        .map_err(SQL)?;
    db.execute(
        "INSERT INTO browser_history_visit_fts(rowid,terms) VALUES(?1,?2)",
        params![id, analyze_search_field(&format!("{title} {url}"))],
    )
    .map_err(SQL)?;
    db.execute(
        "UPDATE browser_history_url SET title=?3,favicon=?4 WHERE url=?1 AND last_visit=?2",
        params![url, time, title, favicon],
    )
    .map_err(SQL)?;
    index_summary(db, url)
}
/// Count only new deduplicated visits; no scan of the URL's previous visits.
fn insert_summary(
    db: &Connection,
    url: &str,
    time: i64,
    visit: &Value,
) -> Result<(), AppStorageError> {
    db.prepare_cached("INSERT INTO browser_history_url(url,title,favicon,last_visit,visits) VALUES(?1,?2,?3,?4,1) ON CONFLICT(url) DO UPDATE SET visits=visits+1,title=CASE WHEN excluded.last_visit>=last_visit THEN excluded.title ELSE title END,favicon=CASE WHEN excluded.last_visit>=last_visit THEN excluded.favicon ELSE favicon END,last_visit=max(last_visit,excluded.last_visit)").map_err(SQL)?.execute(params![url,visit["title"].as_str().unwrap_or(url),visit["favicon"].as_str().unwrap_or(""),time]).map_err(SQL)?;
    Ok(())
}
/// Only inserted visits carry this receipt; native or previously imported visits survive.
pub(super) fn undo_import(db: &Connection, run: &str) -> Result<Value, AppStorageError> {
    let source = format!("imported:{run}");
    let mut statement = db
        .prepare("SELECT DISTINCT url FROM browser_history WHERE source=?1")
        .map_err(SQL)?;
    let urls = statement
        .query_map([&source], |r| r.get::<_, String>(0))
        .map_err(SQL)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SQL)?;
    let count = db
        .execute("DELETE FROM browser_history WHERE source=?1", [&source])
        .map_err(SQL)?;
    for url in urls {
        refresh(db, &url)?;
    }
    Ok(json!({"deleted":count}))
}
