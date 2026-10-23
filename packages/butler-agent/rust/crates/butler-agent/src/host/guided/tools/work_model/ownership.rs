//! Resolve the App-owned conversation label on the blocking pool.
mod sql;
use super::*;

pub(super) async fn label(owner: &GuidedTools, value: &mut Value) {
    if value["error"]["code"] != "owned_elsewhere" {
        return;
    }
    let Some(session) = value["error"]["session_id"].as_str().map(str::to_owned) else {
        return;
    };
    let Some(endpoint) = owner.app_endpoint.snapshot() else {
        return;
    };
    let title = tokio::task::spawn_blocking(move || {
        let db = butler_platform::sqlite::open_with_flags(
            endpoint.database_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .ok()?;
        let derived = session.strip_prefix("butler/app-").unwrap_or(&session);
        db.query_row(
            sql::SESSION_TITLE,
            rusqlite::params![session, derived],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    })
    .await
    .ok()
    .flatten();
    if let Some(title) = title
        && let Ok(message) = store::ownership::ownership_message(&value["error"], &title)
    {
        value["error"]["message"] = json!(message);
    }
}
