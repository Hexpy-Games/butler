//! Read-only adapter for the retained MCP tool's serving graph.

mod serving;

use crate::cognition::{CognitionPathEnvironment, active_memory_descriptor_exists};
use butler_platform::sqlite;

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

/// Failures reading the serving graph for the retained MCP graph tool. `Display` is the
/// text returned to the tool caller.
#[derive(Debug, thiserror::Error)]
pub enum LegacyGraphReadError {
    /// The active-generation descriptor could not be read or parsed.
    #[error("memory_generation_unavailable: {0}")]
    GenerationUnavailable(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The serving graph database could not be queried.
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    /// A stored entity or the response could not be encoded or decoded.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Answers the MCP query from the active generation, or the legacy graph when
/// no descriptor exists. This read-only adapter grants no writer authority.
pub fn read_mcp_legacy_graph(
    data_root: &Path,
    query: &str,
    entity_type: Option<&str>,
    project: Option<&str>,
    max_hops: u32,
) -> Result<String, LegacyGraphReadError> {
    let memory_root = data_root.join("cognition/memory");
    let paths = CognitionPathEnvironment::default();
    if active_memory_descriptor_exists(data_root, &paths)
        .map_err(|error| LegacyGraphReadError::GenerationUnavailable(error.into()))?
    {
        return serving::read(data_root, &paths, query, entity_type, project, max_hops);
    }
    let db_path = memory_root.join("db/graph.sqlite");
    if !db_path.exists() {
        return Ok(json!({"entities": [], "relationships": []}).to_string());
    }
    let connection = sqlite::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let matches = find_entities(&connection, query, entity_type, project)?;
    if matches.is_empty() {
        return Ok(json!({"entities": [], "relationships": []}).to_string());
    }

    let mut entities = Vec::<Value>::new();
    let mut seen = std::collections::HashSet::new();
    let mut relationships = Vec::new();
    for entity in matches.iter().take(5) {
        seen.insert(entity.id.clone());
        entities.push(entity_value(entity)?);
        for related in related_entities(&connection, &entity.id, max_hops)? {
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
    Ok(serde_json::to_string_pretty(
        &json!({"entities": entities, "relationships": relationships}),
    )?)
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

fn entity_value(entity: &Entity) -> Result<Value, LegacyGraphReadError> {
    let properties: Value = if entity.properties.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&entity.properties)?
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

    // test-category: format-pin
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
        serving_graph_format(&root);
        fs::remove_dir_all(root).unwrap();
    }
    fn serving_graph_format(root: &std::path::Path) {
        let id = uuid::Uuid::new_v4().to_string();
        let memory = root.join("cognition/memory");
        let generation = memory.join("generations").join(&id);
        fs::create_dir_all(&generation).unwrap();
        fs::write(
            generation.join("manifest.json"),
            include_str!("generation/fixtures/format/empty-manifest.json").replace("<EMPTY>", &id),
        )
        .unwrap();
        fs::write(
            memory.join("active-generation.json"),
            include_str!("generation/fixtures/format/empty-descriptor.json")
                .replace("<EMPTY>", &id),
        )
        .unwrap();
        let path = generation.join("graph.sqlite");
        crate::cognition::graph::GraphRepository::create_fresh(&path, "2026-10-02T00:00:00.000Z")
            .unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "INSERT INTO memory_nodes(id,type,label_original,identity_scope,project_id,created_at)
             VALUES ('a','concept','Garden','project','garden','now'),
                    ('b','tool','Watering','project','garden','now'),
                    ('c','tool','Private tool','project','other','now');
             INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type)
             VALUES ('ab','a','b','uses'),('bc','b','c','uses');
             INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,project_id,
               origin_kind,status,source_hash,created_at,updated_at)
             VALUES ('chunk','key','r1','garden','user_input','active','hash','now','now');
             INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,
               scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis)
             VALUES ('s','chunk','r1','conversation','p','/text',0,6,'hash','user','user_input','now','user_statement');
             INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind)
             VALUES ('a','Garden','Garden','garden','s','exact');
             INSERT INTO memory_alias_postings(gram,node_id,source_id,surface_original,identity_scope,project_id)
             VALUES ('ard','a','s','Garden','project','garden');"
        ).unwrap();
        drop(db);
        let before = fs::read(&path).unwrap();
        let output =
            read_mcp_legacy_graph(root, "GARD", Some("concept"), Some("garden"), 2).unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            value["entities"],
            serde_json::json!([
                {"id":"a","type":"concept","name":"Garden","project":"garden","properties":{}},
                {"id":"b","type":"tool","name":"Watering","project":"garden","properties":{},"hops":1}
            ])
        );
        assert_eq!(
            value["relationships"],
            serde_json::json!([
                {"from":"a","to":"b","hops":1}
            ])
        );
        assert_eq!(fs::read(path).unwrap(), before);
        let excluded = read_mcp_legacy_graph(root, "garden", Some("person"), None, 2).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&excluded).unwrap()["entities"],
            serde_json::json!([])
        );
    }
}
