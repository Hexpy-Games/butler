//! Read-only adapter for the retained MCP tool's legacy graph database.

use std::path::Path;

use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Map, Value, json};

#[derive(Debug)]
struct Entity {
    id: String,
    entity_type: String,
    name: String,
    project: Option<String>,
    properties: String,
    hops: Option<u32>,
}

pub(crate) fn read_mcp_legacy_graph(
    data_root: &Path,
    query: &str,
    entity_type: Option<&str>,
    project: Option<&str>,
    max_hops: u32,
) -> Result<String, String> {
    let memory_root = data_root.join("cognition/memory");
    reject_generation_writer(&memory_root)?;
    let db_path = memory_root.join("db/graph.sqlite");
    if !db_path.exists() {
        return Ok(json!({"entities": [], "relationships": []}).to_string());
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let matches = find_entities(&connection, query, entity_type, project)
        .map_err(|error| error.to_string())?;
    if matches.is_empty() {
        return Ok(json!({"entities": [], "relationships": []}).to_string());
    }

    let mut entities = Vec::<Value>::new();
    let mut seen = std::collections::HashSet::new();
    let mut relationships = Vec::new();
    for entity in matches.iter().take(5) {
        seen.insert(entity.id.clone());
        entities.push(entity_value(entity)?);
        for related in related_entities(&connection, &entity.id, max_hops)
            .map_err(|error| error.to_string())?
        {
            if project.is_some_and(|project| related.project.as_deref() != Some(project)) {
                continue;
            }
            if seen.insert(related.id.clone()) {
                entities.push(entity_value(&related)?);
            }
            relationships.push(json!({
                "from": entity.id,
                "to": related.id,
                "hops": related.hops.unwrap_or_default(),
            }));
        }
    }
    serde_json::to_string_pretty(&json!({"entities": entities, "relationships": relationships}))
        .map_err(|error| error.to_string())
}

fn reject_generation_writer(memory_root: &Path) -> Result<(), String> {
    let descriptor = memory_root.join("active-generation.json");
    let bytes = match std::fs::read(descriptor) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("memory_generation_unavailable: {error}")),
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("memory_generation_unavailable: {error}"))?;
    if value["schema"] == "butler.memory-active-generation.v2" {
        return Err("legacy_memory_writer_disabled_for_v2".into());
    }
    Ok(())
}

fn find_entities(
    connection: &Connection,
    query: &str,
    entity_type: Option<&str>,
    project: Option<&str>,
) -> rusqlite::Result<Vec<Entity>> {
    let pattern = format!("%{}%", query.to_lowercase());
    let mut statement = connection.prepare(&format!(
        "SELECT id, type, name, project, properties FROM entities WHERE lower(name) LIKE ?1{}{} LIMIT 20",
        if entity_type.is_some() { " AND type = ?2" } else { "" },
        if project.is_some() {
            if entity_type.is_some() { " AND project = ?3" } else { " AND project = ?2" }
        } else {
            ""
        }
    ))?;
    let rows = match (entity_type, project) {
        (Some(entity_type), Some(project)) => {
            statement.query_map(params![pattern, entity_type, project], entity_row)?
        }
        (Some(entity_type), None) => {
            statement.query_map(params![pattern, entity_type], entity_row)?
        }
        (None, Some(project)) => statement.query_map(params![pattern, project], entity_row)?,
        (None, None) => statement.query_map(params![pattern], entity_row)?,
    };
    rows.collect()
}

fn related_entities(
    connection: &Connection,
    entity_id: &str,
    max_hops: u32,
) -> rusqlite::Result<Vec<Entity>> {
    let mut statement = connection.prepare(
        "WITH RECURSIVE traversal(entity_id, hops) AS (
            SELECT ?1, 0
            UNION
            SELECT e.target_id, t.hops + 1 FROM traversal t
              JOIN edges e ON e.source_id = t.entity_id WHERE t.hops < ?2
            UNION
            SELECT e.source_id, t.hops + 1 FROM traversal t
              JOIN edges e ON e.target_id = t.entity_id WHERE t.hops < ?2
         )
         SELECT DISTINCT en.id, en.type, en.name, en.project, en.properties, MIN(t.hops) as hops
         FROM traversal t JOIN entities en ON en.id = t.entity_id
         WHERE en.id != ?1 GROUP BY en.id ORDER BY hops ASC",
    )?;
    let rows = statement.query_map(params![entity_id, max_hops], |row| {
        Ok(Entity {
            id: row.get(0)?,
            entity_type: row.get(1)?,
            name: row.get(2)?,
            project: row.get(3)?,
            properties: row.get(4)?,
            hops: row.get(5)?,
        })
    })?;
    rows.collect()
}

fn entity_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entity> {
    Ok(Entity {
        id: row.get(0)?,
        entity_type: row.get(1)?,
        name: row.get(2)?,
        project: row.get(3)?,
        properties: row.get(4)?,
        hops: None,
    })
}

fn entity_value(entity: &Entity) -> Result<Value, String> {
    let properties: Value = if entity.properties.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&entity.properties).map_err(|error| error.to_string())?
    };
    let mut value = Map::new();
    value.insert("id".into(), Value::String(entity.id.clone()));
    value.insert("type".into(), Value::String(entity.entity_type.clone()));
    value.insert("name".into(), Value::String(entity.name.clone()));
    value.insert(
        "project".into(),
        entity
            .project
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    value.insert("properties".into(), properties);
    if let Some(hops) = entity.hops {
        value.insert("hops".into(), Value::Number(hops.into()));
    }
    Ok(Value::Object(value))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use rusqlite::Connection;

    use super::read_mcp_legacy_graph;

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "butler-mcp-graph-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("cognition/memory/db")).unwrap();
        root
    }

    #[test]
    fn missing_legacy_graph_is_empty_without_creating_it() {
        let root = root();
        assert_eq!(
            read_mcp_legacy_graph(&root, "butler", None, None, 2).unwrap(),
            r#"{"entities":[],"relationships":[]}"#
        );
        assert!(!root.join("cognition/memory/db/graph.sqlite").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_graph_search_and_bidirectional_hops_use_read_only_schema() {
        let root = root();
        let path = root.join("cognition/memory/db/graph.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "CREATE TABLE entities (id TEXT, type TEXT, name TEXT, project TEXT, properties TEXT);
             CREATE TABLE edges (source_id TEXT, target_id TEXT);
             INSERT INTO entities VALUES ('a','project','Butler',NULL,'{\"k\":1}');
             INSERT INTO entities VALUES ('b','tool','Native tool','butler','{}');
             INSERT INTO edges VALUES ('a','b');",
        ).unwrap();
        drop(connection);
        let output = read_mcp_legacy_graph(&root, "butler", None, None, 2).unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["entities"].as_array().unwrap().len(), 2);
        assert_eq!(value["entities"][0]["properties"]["k"], 1);
        assert_eq!(value["relationships"][0]["hops"], 1);
        assert!(fs::metadata(path).unwrap().len() > 0);
        fs::remove_dir_all(root).unwrap();
    }
}
