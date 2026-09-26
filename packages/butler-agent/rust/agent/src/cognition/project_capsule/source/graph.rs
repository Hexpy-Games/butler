use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use tokio_util::sync::CancellationToken;

use crate::cognition::{CognitionResult, mutable_paths::ensure_data_authority};

use super::super::{check_active, types::ProjectGraphEvidence};

const LIMIT: i64 = 12;

pub(super) fn list(
    data_root: &Path,
    memory_root: &Path,
    project_id: &str,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<Vec<ProjectGraphEvidence>> {
    check_active(cancellation, deadline)?;
    let path = memory_root.join("db/graph.sqlite");
    ensure_data_authority(data_root, &[&path])?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let Ok(connection) = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return Ok(Vec::new());
    };
    Ok(read_project_rows(&connection, project_id).unwrap_or_default())
}

pub(super) fn are_current(
    data_root: &Path,
    memory_root: &Path,
    project_id: &str,
    expected: &[ProjectGraphEvidence],
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<bool> {
    if expected.is_empty() {
        return Ok(true);
    }
    check_active(cancellation, deadline)?;
    let path = memory_root.join("db/graph.sqlite");
    ensure_data_authority(data_root, &[&path])?;
    if !path.exists() {
        return Ok(false);
    }
    let Ok(connection) = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return Ok(false);
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT m.id,m.session_id,m.project,m.snippet,e.project,e.name
         FROM entity_mentions m JOIN entities e ON e.id=m.entity_id WHERE m.id=?1",
    ) else {
        return Ok(false);
    };
    for expected_row in expected {
        check_active(cancellation, deadline)?;
        let current = statement
            .query_row([expected_row.source_id], |row| {
                Ok(ProjectGraphEvidence {
                    source_id: row.get(0)?,
                    provenance: provenance(
                        row.get::<_, Option<String>>(1)?.as_ref(),
                        expected_row.source_id,
                    ),
                    mention_project: row.get(2)?,
                    text: evidence_text(row.get(3)?, row.get(5)?),
                    entity_project: row.get(4)?,
                })
            })
            .ok();
        let Some(current) = current else {
            return Ok(false);
        };
        if current != *expected_row
            || (current.mention_project.as_deref() != Some(project_id)
                && current.entity_project.as_deref() != Some(project_id))
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn read_project_rows(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ProjectGraphEvidence>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT m.id,m.session_id,m.project,m.snippet,e.project,e.name
         FROM entity_mentions m JOIN entities e ON e.id=m.entity_id
         WHERE m.snippet IS NOT NULL AND length(m.snippet)>0
           AND (m.project=?1 OR e.project=?1)
         ORDER BY m.timestamp DESC LIMIT ?2",
    )?;
    let rows = statement.query_map((project_id, LIMIT), |row| {
        let source_id = row.get(0)?;
        Ok(ProjectGraphEvidence {
            source_id,
            provenance: provenance(row.get::<_, Option<String>>(1)?.as_ref(), source_id),
            mention_project: row.get(2)?,
            text: evidence_text(row.get(3)?, row.get(5)?),
            entity_project: row.get(4)?,
        })
    })?;
    rows.collect()
}

fn provenance(session_id: Option<&String>, source_id: i64) -> String {
    match session_id {
        Some(session) if !session.is_empty() => format!("graph:{session}"),
        _ => format!("graph:{source_id}"),
    }
}

fn evidence_text(snippet: Option<String>, name: String) -> String {
    snippet.filter(|text| !text.is_empty()).unwrap_or(name)
}
