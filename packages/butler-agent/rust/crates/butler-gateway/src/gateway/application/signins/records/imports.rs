//! Indexed per-run ownership. Audit records continue to contain counts only.
use super::{Result, sql};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(super) fn track(db: &Connection, run: &str, kind: &str, id: &str) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO browser_import_additions VALUES(?1,?2,?3)",
        params![run, kind, id],
    )
    .map_err(sql)?;
    Ok(())
}
pub(super) fn additions(db: &Connection, run: &str) -> Result<Value> {
    let mut statement = db.prepare("SELECT a.kind,a.entry_id,CASE WHEN a.kind<>'passwords' OR v.revision=a.run_id THEN 1 ELSE 0 END FROM browser_import_additions a LEFT JOIN browser_signin_versions v ON v.entry_id=a.entry_id WHERE a.run_id=?1 UNION ALL SELECT 'updated',u.entry_id,CASE WHEN v.revision=u.revision THEN 1 ELSE 0 END FROM browser_import_updates u LEFT JOIN browser_signin_versions v ON v.entry_id=u.entry_id WHERE u.run_id=?1 ORDER BY 1,2").map_err(sql)?;
    let rows = statement
        .query_map([run], |r| {
            Ok(json!({"kind":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"current":r.get::<_,bool>(2)?}))
        })
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    Ok(json!({"items":rows}))
}
pub(super) fn forget(db: &Connection, run: &str, kind: &str, id: &str) -> Result<Value> {
    db.execute(
        "DELETE FROM browser_import_additions WHERE run_id=?1 AND kind=?2 AND entry_id=?3",
        params![run, kind, id],
    )
    .map_err(sql)?;
    Ok(json!({"ok":true}))
}
pub(super) fn undo_bookmark(db: &Connection, run: &str, id: &str) -> Result<Value> {
    let owns = db.query_row("SELECT 1 FROM browser_import_additions WHERE run_id=?1 AND kind='bookmarks' AND entry_id=?2",params![run,id],|_| Ok(())).optional().map_err(sql)?.is_some();
    let present = owns
        && db
            .query_row(
                "SELECT 1 FROM browser_library WHERE id=?1",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map_err(sql)?
            .is_some();
    if present {
        crate::gateway::application::library::delete(db, id)?;
    }
    let deleted = json!({"deleted":present});
    forget(db, run, "bookmarks", id)?;
    Ok(deleted)
}
pub(super) fn bookmarks(db: &Connection, items: &[Value], run: &str) -> Result<Value> {
    let (mut imported, mut existing) = (0_u64, 0_u64);
    for item in items {
        let saved = crate::gateway::application::library::bookmark_in_folder(
            db,
            item["url"].as_str().unwrap_or_default(),
            item["folder"].as_str().unwrap_or_default(),
        )?;
        if saved {
            existing += 1;
            continue;
        }
        let mut item = item.clone();
        let id = item["id"].as_str().unwrap_or_default().to_owned();
        let collision = db
            .query_row("SELECT 1 FROM browser_library WHERE id=?1", [&id], |_| {
                Ok(())
            })
            .optional()
            .map_err(sql)?
            .is_some();
        if collision {
            item["id"] = json!(format!("bookmark-{}", uuid::Uuid::new_v4()));
        }
        crate::gateway::application::library::save(db, &item)?;
        track(
            db,
            run,
            "bookmarks",
            item["id"].as_str().unwrap_or_default(),
        )?;
        imported += 1;
    }
    Ok(json!({"imported":imported,"existing":existing}))
}
