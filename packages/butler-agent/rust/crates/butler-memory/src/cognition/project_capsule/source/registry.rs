//! Read the App's canonical project identities without creating or migrating its DB.
use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::super::{check_active, error, types::ProjectRegistryEntry};
use crate::cognition::{CognitionCode, CognitionResult, mutable_paths::ensure_data_authority};

pub(super) fn app_entries(
    data_root: &Path,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<Vec<ProjectRegistryEntry>> {
    let path = data_root.join("app-server/butler-client.sqlite");
    ensure_data_authority(data_root, &[&path])?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let read = || -> rusqlite::Result<Vec<ProjectRegistryEntry>> {
        let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut statement = db.prepare(
            "SELECT id,display_name,workspace_path FROM projects WHERE archived=0 ORDER BY id",
        )?;
        statement
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let display_name: String = row.get(1)?;
                let path: Option<String> = row.get(2)?;
                Ok(ProjectRegistryEntry {
                    name: id.clone(),
                    raw: json!({"name":id,"display_name":display_name,"path":path}),
                })
            })?
            .collect()
    };
    check_active(cancellation, deadline)?;
    read().map_err(|source| error(CognitionCode::ProjectCapsuleSourceInvalid).with_source(source))
}
