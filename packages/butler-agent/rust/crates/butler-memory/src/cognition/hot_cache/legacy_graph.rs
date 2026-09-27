use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use crate::cognition::CognitionCode;
use crate::cognition::CognitionError;
use crate::cognition::CognitionResult;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};

use crate::cognition::mutable_paths::ensure_data_authority;

use super::rules::{self, ExtractedEdge, ExtractedEntity};

pub(super) fn extract_and_save(
    data_root: &Path,
    memory_root: &Path,
    text: &str,
    session_id: &str,
    project: &str,
    source: Option<&str>,
    timestamp: i64,
) -> CognitionResult<usize> {
    let extraction = rules::extract(data_root, text, project)?;
    if extraction.entities.is_empty() {
        return Ok(0);
    }
    let snippet = rules::mention_snippet(text);
    let mut connection = open_legacy_graph(data_root, memory_root)?;
    let transaction = connection
        .transaction()
        .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
    let mut id_map = HashMap::new();

    for entity in &extraction.entities {
        let id = entity_id(entity);
        transaction
            .execute(
                "INSERT INTO entities (id,type,name,project,properties,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,'{}',?5,?5)
                 ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,
                    properties=excluded.properties",
                params![id, entity.kind, entity.name, entity.project, timestamp],
            )
            .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
        transaction
            .execute(
                "INSERT INTO entity_mentions (entity_id,session_id,timestamp,snippet,source,project)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![id, session_id, timestamp, snippet, source, project],
            )
            .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
        id_map.insert(entity_key(entity.kind, &entity.name), id);
    }

    for edge in &extraction.edges {
        let Some(source_id) = id_map.get(&entity_key(edge.source_type, &edge.source_name)) else {
            continue;
        };
        let Some(target_id) = id_map.get(&entity_key(edge.target_type, &edge.target_name)) else {
            continue;
        };
        upsert_edge(
            &transaction,
            source_id,
            target_id,
            edge,
            session_id,
            timestamp,
        )?;
    }

    transaction
        .commit()
        .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
    Ok(extraction.entities.len())
}

fn open_legacy_graph(data_root: &Path, memory_root: &Path) -> CognitionResult<Connection> {
    let descriptor_path = memory_root.join("active-generation.json");
    ensure_data_authority(data_root, &[memory_root, &descriptor_path])?;
    match fs::read_to_string(&descriptor_path) {
        Ok(text) => {
            let descriptor =
                serde_json::from_str::<serde_json::Value>(&text).map_err(|source| {
                    legacy(CognitionCode::MemoryGenerationUnavailable).with_source(source)
                })?;
            if descriptor.get("schema").and_then(serde_json::Value::as_str)
                == Some("butler.memory-active-generation.v2")
            {
                return Err(legacy(CognitionCode::LegacyMemoryWriterDisabledForV2));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(legacy(CognitionCode::MemoryGenerationUnavailable).with_source(error));
        }
    }

    let db_directory = memory_root.join("db");
    let db_path = db_directory.join("graph.sqlite");
    let wal_path = sidecar(&db_path, "-wal");
    let shm_path = sidecar(&db_path, "-shm");
    let journal_path = sidecar(&db_path, "-journal");
    ensure_data_authority(
        data_root,
        &[&db_directory, &db_path, &wal_path, &shm_path, &journal_path],
    )?;
    fs::create_dir_all(&db_directory)
        .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
    ensure_data_authority(
        data_root,
        &[&db_directory, &db_path, &wal_path, &shm_path, &journal_path],
    )?;

    let connection = Connection::open(&db_path)
        .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
    ensure_schema(&connection)?;
    Ok(connection)
}

fn ensure_schema(connection: &Connection) -> CognitionResult<()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                project TEXT,
                properties TEXT DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL REFERENCES entities(id),
                target_id TEXT NOT NULL REFERENCES entities(id),
                rel_type TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                properties TEXT DEFAULT '{}',
                session_id TEXT,
                created_at INTEGER NOT NULL,
                UNIQUE(source_id,target_id,rel_type)
            );
            CREATE TABLE IF NOT EXISTS entity_mentions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id TEXT NOT NULL REFERENCES entities(id),
                session_id TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                snippet TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
            CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);
            CREATE INDEX IF NOT EXISTS idx_mentions_session ON entity_mentions(session_id);
            CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);",
        )
        .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
    let _ = connection.execute("ALTER TABLE entity_mentions ADD COLUMN source TEXT", []);
    let _ = connection.execute("ALTER TABLE entity_mentions ADD COLUMN project TEXT", []);
    Ok(())
}

fn upsert_edge(
    connection: &Connection,
    source_id: &str,
    target_id: &str,
    edge: &ExtractedEdge,
    session_id: &str,
    timestamp: i64,
) -> CognitionResult<()> {
    connection
        .execute(
            "INSERT INTO edges (source_id,target_id,rel_type,weight,properties,session_id,created_at)
             VALUES (?1,?2,?3,1.0,'{}',?4,?5)
             ON CONFLICT(source_id,target_id,rel_type) DO UPDATE SET
                weight=weight+1.0,session_id=excluded.session_id",
            params![source_id, target_id, edge.relation, session_id, timestamp],
        )
        .map_err(|source| legacy(CognitionCode::MemoryGraphUnavailable).with_source(source))?;
    Ok(())
}

fn entity_id(entity: &ExtractedEntity) -> String {
    let key = format!(
        "{}|{}|{}",
        entity.kind,
        entity.name.to_lowercase(),
        entity.project.as_deref().unwrap_or_default()
    );
    // Hex of the first 8 digest bytes.
    let mut hex = format!("{:x}", Sha256::digest(key.as_bytes()));
    hex.truncate(16);
    hex
}

fn entity_key(kind: &str, name: &str) -> String {
    format!("{kind}|{name}")
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests;

/// Legacy graph failures carry their code as the message, as before.
fn legacy(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
