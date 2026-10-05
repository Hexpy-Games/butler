//! Staged hot projection retains only surviving episodes, without re-rendering them.
use std::{collections::HashSet, fs, io, io::Write, path::Path};

pub(super) fn copy(old: &Path, new: &Path) -> io::Result<()> {
    let db = butler_platform::sqlite::open_with_flags(
        new.join("graph.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
    )
    .map_err(io::Error::other)?;
    let mut query = db
        .prepare("SELECT memory_chunk_id FROM memory_chunks WHERE status='active'")
        .map_err(io::Error::other)?;
    let episodes = query
        .query_map([], |row| row.get(0))
        .map_err(io::Error::other)?
        .collect::<Result<HashSet<String>, _>>()
        .map_err(io::Error::other)?;
    rebind_receipts(&db, old, new)?;
    let body = match fs::read_to_string(old.join("hot/cache.md")) {
        Ok(body) => body,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let body = super::super::cache::reset_body(&body, &episodes).map_err(io::Error::other)?;
    butler_platform::secure_fs::create_private_dir_all(&new.join("hot"))?;
    butler_platform::secure_fs::replace_private(
        &new.join("hot/cache.md"),
        |file| file.write_all(body.as_bytes()),
        |error| error,
    )
}

fn rebind_receipts(db: &rusqlite::Connection, old: &Path, new: &Path) -> io::Result<()> {
    for (table, id, column) in [
        ("memory_projection_jobs", "job_id", "hot_cache_receipt_json"),
        ("memory_hot_cache_outcomes", "entry_id", "receipt_json"),
    ] {
        let mut query = db
            .prepare(&format!(
                "SELECT {id},{column} FROM {table} WHERE {column} IS NOT NULL"
            ))
            .map_err(io::Error::other)?;
        let rows = query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(io::Error::other)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        for (key, raw) in rows {
            let mut value: serde_json::Value =
                serde_json::from_str(&raw).map_err(io::Error::other)?;
            rebind(&mut value, old, new)?;
            db.execute(
                &format!("UPDATE {table} SET {column}=?1 WHERE {id}=?2"),
                (value.to_string(), key),
            )
            .map_err(io::Error::other)?;
        }
    }
    Ok(())
}
fn rebind(value: &mut serde_json::Value, old: &Path, new: &Path) -> io::Result<()> {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                rebind(value, old, new)?;
            }
        }
        serde_json::Value::Object(values) => {
            for (name, value) in values {
                if matches!(name.as_str(), "generation_id" | "generation") {
                    if let Some(id) = new.file_name().and_then(|id| id.to_str()) {
                        *value = serde_json::json!(id);
                    }
                } else if name == "path" {
                    if let Some(path) = value
                        .as_str()
                        .and_then(|path| Path::new(path).strip_prefix(old).ok())
                    {
                        *value = serde_json::json!(new.join(path));
                    }
                } else {
                    rebind(value, old, new)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}
