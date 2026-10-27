//! Sign-in rows. Callers own the enclosing transaction; values never include secrets.
mod imports;
mod versions;
use super::{AppSignInCommand, AppSignInUpsert};
use crate::gateway::application::AppStorageError;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, AppStorageError>;
fn sql(error: rusqlite::Error) -> AppStorageError {
    AppStorageError::sqlite(error)
}

pub(super) fn read(db: &Connection, command: AppSignInCommand) -> Result<Value> {
    match command {
        AppSignInCommand::List => list(db),
        AppSignInCommand::ImportAdditions { run_id } => imports::additions(db, &run_id),
        AppSignInCommand::Lookup { site } => Ok(json!({"entry": entry_where(db, "site", &site)?})),
        AppSignInCommand::Entry { id } => Ok(json!({"entry": entry_where(db, "id", &id)?})),
        AppSignInCommand::Grants { session, turn } => grants(db, &session, turn.as_deref()),
        _ => Ok(Value::Null),
    }
}

pub(super) fn write(
    db: &Connection,
    command: AppSignInCommand,
    now: &str,
    id: &str,
) -> Result<Value> {
    match command {
        AppSignInCommand::Upsert(input) => upsert(db, &input, now, id),
        AppSignInCommand::FinishImportUpdate {
            id,
            run_id,
            modified_ms,
        } => versions::finish(db, &id, &run_id, modified_ms),
        AppSignInCommand::RestoreImportUpdate { id, run_id } => versions::restore(db, &id, &run_id),
        AppSignInCommand::Forget { id } | AppSignInCommand::Delete { id } => {
            db.execute(
                "DELETE FROM browser_signin_identity WHERE entry_id=?1",
                [&id],
            )
            .map_err(sql)?;
            db.execute(
                "DELETE FROM browser_import_additions WHERE kind='passwords' AND entry_id=?1",
                [&id],
            )
            .map_err(sql)?;
            db.execute(
                "DELETE FROM browser_signin_versions WHERE entry_id=?1",
                [&id],
            )
            .map_err(sql)?;
            let removed = db
                .execute("DELETE FROM browser_signin_entries WHERE id=?1", [&id])
                .map_err(sql)?;
            Ok(json!({"removed": removed > 0}))
        }
        AppSignInCommand::SetPolicy { id, policy } => {
            let changed = db
                .execute(
                    "UPDATE browser_signin_entries SET policy=?1 WHERE id=?2",
                    params![policy, id],
                )
                .map_err(sql)?;
            Ok(json!({"changed": changed > 0}))
        }
        AppSignInCommand::SetAllConversations { site, value } => {
            db.execute(
                "INSERT INTO browser_site_access(site,all_conversations,updated_at) VALUES(?1,?2,?3) \
                 ON CONFLICT(site) DO UPDATE SET all_conversations=excluded.all_conversations,updated_at=excluded.updated_at",
                params![site, i64::from(value), now],
            )
            .map_err(sql)?;
            Ok(json!({"changed": true}))
        }
        AppSignInCommand::Revoke { site } => revoke(db, &site, now),
        AppSignInCommand::ImportBookmarks { items, run_id } => {
            imports::bookmarks(db, &items, &run_id)
        }
        AppSignInCommand::UndoBookmark { run_id, id } => imports::undo_bookmark(db, &run_id, &id),
        AppSignInCommand::ForgetAddition { run_id, kind, id } => {
            imports::forget(db, &run_id, &kind, &id)
        }
        AppSignInCommand::List
        | AppSignInCommand::Lookup { .. }
        | AppSignInCommand::Entry { .. }
        | AppSignInCommand::Grants { .. } => read(db, command),
        other => record(db, other, now),
    }
}

/// Append-only records: grants, fill audit, schedule sources and import summaries.
fn record(db: &Connection, command: AppSignInCommand, now: &str) -> Result<Value> {
    match command {
        AppSignInCommand::Grant {
            session,
            site,
            source,
        } => {
            db.execute(
                "INSERT OR IGNORE INTO browser_site_grants(session_id,site,source,created_at) \
                 VALUES(?1,?2,?3,?4)",
                params![session, site, source, now],
            )
            .map_err(sql)?;
            Ok(json!({"granted": true}))
        }
        AppSignInCommand::Audit {
            entry_id,
            session,
            turn,
            origin,
            result,
        } => {
            db.execute(
                "INSERT INTO browser_signin_audit(entry_id,session_id,turn_id,origin,result,created_at) \
                 VALUES(?1,?2,?3,?4,?5,?6)",
                params![entry_id, session, turn, origin, result, now],
            )
            .map_err(sql)?;
            db.execute(
                "UPDATE browser_signin_entries SET last_used_at=?1 WHERE id=?2",
                params![now, entry_id],
            )
            .map_err(sql)?;
            Ok(json!({"recorded": true}))
        }
        AppSignInCommand::ScheduleSource {
            automation_id,
            source_session,
        } => {
            db.execute(
                "INSERT OR IGNORE INTO app_automation_grant_sources(automation_id,source_session_id) VALUES(?1,?2)",
                params![automation_id, source_session],
            )
            .map_err(sql)?;
            Ok(json!({"recorded": true}))
        }
        AppSignInCommand::ImportSummary {
            source,
            kind,
            counts,
        } => {
            db.execute(
                "INSERT INTO browser_import_audit(source,kind,counts_json,created_at) VALUES(?1,?2,?3,?4)",
                params![source, kind, counts.to_string(), now],
            )
            .map_err(sql)?;
            Ok(json!({"recorded": true}))
        }
        _ => Ok(Value::Null),
    }
}

const ENTRY_COLUMNS: &str = "id,site,origins_json,username,policy,created_at,last_used_at,source";

fn entry_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let origins: String = row.get(2)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?, "site": row.get::<_, String>(1)?,
        "origins": serde_json::from_str::<Value>(&origins).unwrap_or_else(|_| json!([])),
        "username": row.get::<_, String>(3)?, "policy": row.get::<_, String>(4)?,
        "created_at": row.get::<_, String>(5)?, "last_used_at": row.get::<_, Option<String>>(6)?,
        "source": row.get::<_, String>(7)?,
    }))
}

fn entry_where(db: &Connection, column: &str, value: &str) -> Result<Option<Value>> {
    let column = if column == "id" { "id" } else { "site" };
    db.query_row(
        &format!("SELECT {ENTRY_COLUMNS} FROM browser_signin_entries WHERE {column}=?1"),
        [value],
        entry_row,
    )
    .optional()
    .map_err(sql)
}

fn upsert(db: &Connection, input: &AppSignInUpsert, now: &str, id: &str) -> Result<Value> {
    if input.source == "manual"
        && let Some(existing) = entry_where(db, "site", &input.site)?
    {
        let id = existing["id"].as_str().unwrap_or_default();
        versions::set(
            db,
            id,
            versions::millis(now),
            &uuid::Uuid::new_v4().to_string(),
        )?;
        db.execute(
            "DELETE FROM browser_signin_identity WHERE entry_id=?1",
            [id],
        )
        .map_err(sql)?;
        db.execute(
            "UPDATE browser_signin_entries SET username=?1,origins_json=?2 WHERE id=?3",
            params![input.username, json!([input.origin]).to_string(), id],
        )
        .map_err(sql)?;
        db.execute(
            "INSERT INTO browser_signin_identity(origin,username,entry_id) VALUES(?1,?2,?3)",
            params![input.origin, input.username, id],
        )
        .map_err(sql)?;
        return Ok(json!({"id":id,"action":"replaced"}));
    }
    let existing: Option<String> = db
        .query_row(
            "SELECT entry_id FROM browser_signin_identity WHERE origin=?1 AND username=?2",
            params![input.origin, input.username],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    if let Some(id) = existing {
        let latest = versions::latest(db, &id)?;
        let action = if input.source == "import" {
            if input.modified_ms.is_some_and(|t| t > latest) {
                "updated"
            } else {
                "skipped"
            }
        } else {
            versions::set(
                db,
                &id,
                versions::millis(now),
                &uuid::Uuid::new_v4().to_string(),
            )?;
            "updated"
        };
        return Ok(json!({"id":id,"action":action}));
    }
    db.execute("INSERT INTO browser_signin_entries(id,site,origins_json,username,policy,created_at,source) VALUES(?1,?2,?3,?4,'ask',?5,?6)",
        params![id,input.site,json!([input.origin]).to_string(),input.username,now,input.source]).map_err(sql)?;
    db.execute(
        "INSERT INTO browser_signin_identity(origin,username,entry_id) VALUES(?1,?2,?3)",
        params![input.origin, input.username, id],
    )
    .map_err(sql)?;
    versions::set(
        db,
        id,
        input.modified_ms.unwrap_or_else(|| versions::millis(now)),
        input
            .import_run
            .as_deref()
            .unwrap_or(&uuid::Uuid::new_v4().to_string()),
    )?;
    if let Some(run) = &input.import_run {
        imports::track(db, run, "passwords", id)?;
    }
    Ok(json!({"id":id,"action":"inserted"}))
}

fn revoke(db: &Connection, site: &str, now: &str) -> Result<Value> {
    let revoked = db
        .execute("DELETE FROM browser_site_grants WHERE site=?1", [site])
        .map_err(sql)?;
    db.execute(
        "INSERT INTO browser_site_access(site,all_conversations,updated_at) VALUES(?1,0,?2) \
         ON CONFLICT(site) DO UPDATE SET all_conversations=0,updated_at=excluded.updated_at",
        params![site, now],
    )
    .map_err(sql)?;
    Ok(json!({"revoked": revoked}))
}

/// Own grants, standing allows and, for a schedule run, its source conversations' grants.
fn grants(db: &Connection, session: &str, turn: Option<&str>) -> Result<Value> {
    let mut sessions = vec![session.to_owned()];
    if let Some(turn) = turn.filter(|turn| !turn.is_empty()) {
        let mut statement = db
            .prepare(
                "SELECT s.source_session_id FROM app_automation_runs r \
                 JOIN app_automation_grant_sources s ON s.automation_id=r.automation_id \
                 JOIN app_automations a ON a.id=r.automation_id \
                 WHERE r.turn_id=?1 AND r.target_session_id=?2 \
                 UNION SELECT s.source_session_id FROM turns t \
                 JOIN app_automation_run_inputs i ON i.message_id=t.user_message_id \
                 JOIN app_automation_runs r ON r.id=i.run_id \
                 JOIN app_automation_grant_sources s ON s.automation_id=r.automation_id \
                 JOIN app_automations a ON a.id=r.automation_id \
                 WHERE t.id=?1 AND t.chat_id=?2 AND r.target_session_id=?2",
            )
            .map_err(sql)?;
        let sources = statement
            .query_map(params![turn, session], |row| row.get::<_, String>(0))
            .map_err(sql)?;
        for source in sources {
            sessions.push(source.map_err(sql)?);
        }
    }
    let mut sites = Vec::<String>::new();
    let mut statement = db
        .prepare("SELECT site FROM browser_site_grants WHERE session_id=?1")
        .map_err(sql)?;
    for owner in &sessions {
        for site in statement
            .query_map([owner], |row| row.get::<_, String>(0))
            .map_err(sql)?
        {
            sites.push(site.map_err(sql)?);
        }
    }
    let mut standing = db
        .prepare("SELECT site FROM browser_site_access WHERE all_conversations=1")
        .map_err(sql)?;
    for site in standing
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql)?
    {
        sites.push(site.map_err(sql)?);
    }
    sites.sort();
    sites.dedup();
    Ok(json!({"sites": sites, "inherited": sessions.len() > 1}))
}

fn list(db: &Connection) -> Result<Value> {
    let mut statement = db
        .prepare(
            "SELECT site FROM browser_signin_entries UNION SELECT site FROM browser_site_grants \
             UNION SELECT site FROM browser_site_access WHERE all_conversations=1 ORDER BY 1",
        )
        .map_err(sql)?;
    let sites = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    let mut rows = Vec::with_capacity(sites.len());
    for site in sites {
        let base = site_row(db, &site)?;
        let mut entries = db.prepare(&format!("SELECT {ENTRY_COLUMNS} FROM browser_signin_entries WHERE site=?1 ORDER BY created_at,id")).map_err(sql)?;
        let entries = entries
            .query_map([&site], entry_row)
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        if entries.is_empty() {
            rows.push(base);
            continue;
        }
        for entry in entries {
            let mut row = base.clone();
            row["entry"] = entry;
            rows.push(row);
        }
    }
    Ok(json!({"sites": rows}))
}

fn site_row(db: &Connection, site: &str) -> Result<Value> {
    let entry = entry_where(db, "site", site)?;
    let conversations: i64 = db
        .query_row(
            "SELECT COUNT(DISTINCT session_id) FROM browser_site_grants WHERE site=?1",
            [site],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let all = db
        .query_row(
            "SELECT all_conversations FROM browser_site_access WHERE site=?1",
            [site],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(sql)?
        == Some(1);
    let mut uses = Vec::new();
    if let Some(id) = entry.as_ref().and_then(|e| e["id"].as_str()) {
        let mut statement = db
            .prepare(
                "SELECT result,created_at,session_id FROM browser_signin_audit WHERE entry_id=?1 ORDER BY id DESC LIMIT 3",
            )
            .map_err(sql)?;
        for row in statement
            .query_map([id], |row| {
                Ok(json!({"result": row.get::<_, String>(0)?, "at": row.get::<_, String>(1)?, "session": row.get::<_, String>(2)?}))
            })
            .map_err(sql)?
        {
            uses.push(row.map_err(sql)?);
        }
    }
    Ok(
        json!({"site": site, "entry": entry, "conversations": conversations, "all_conversations": all, "uses": uses}),
    )
}
