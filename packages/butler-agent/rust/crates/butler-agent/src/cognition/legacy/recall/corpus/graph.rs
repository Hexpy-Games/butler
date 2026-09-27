use std::{collections::HashMap, path::Path};

use rusqlite::{Connection, OpenFlags, params};

use crate::cognition::{CognitionResult, ensure_data_authority};

use super::super::types::{
    LegacyRecallCandidate, LegacyRecallCorpus, LegacyRecallEdge, LegacyRecallNode,
    LegacyRecallOriginalSource, LegacyRecallSource,
};

const GRAPH_CANDIDATE_SUMMARY_CHARS: usize = 180;
const GRAPH_MENTION_LIMIT: usize = 200;

pub(super) fn load(
    data_root: &Path,
    path: &Path,
    project_id: Option<&str>,
) -> CognitionResult<LegacyRecallCorpus> {
    ensure_data_authority(data_root, &[path])?;
    if !path.exists() {
        return Ok(LegacyRecallCorpus::default());
    }
    Ok(read_legacy_graph(path, project_id).unwrap_or_default())
}

fn read_legacy_graph(
    path: &Path,
    project_id: Option<&str>,
) -> rusqlite::Result<LegacyRecallCorpus> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let nodes = {
        let mut statement = connection.prepare(
            "SELECT e.id, e.type, e.name, COUNT(edge.id) AS degree
             FROM memory_nodes e
             LEFT JOIN edges edge ON edge.source_id = e.id OR edge.target_id = e.id
             GROUP BY e.id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(LegacyRecallNode {
                id: row.get(0)?,
                name: row.get(2)?,
                degree: Some(row.get::<_, i64>(3)? as f64),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let edges = {
        let mut statement =
            connection.prepare("SELECT source_id, target_id, rel_type, weight FROM edges")?;
        let rows = statement.query_map([], |row| {
            Ok(LegacyRecallEdge {
                source_id: row.get(0)?,
                target_id: row.get(1)?,
                weight: row.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let candidates = group_graph_mentions(read_graph_mentions(&connection, project_id)?);
    Ok(LegacyRecallCorpus {
        nodes,
        edges,
        candidates,
    })
}

#[derive(Debug)]
struct GraphMention {
    id: i64,
    session_id: String,
    timestamp: f64,
    snippet: String,
    node_id: String,
}

fn read_graph_mentions(
    connection: &Connection,
    project_id: Option<&str>,
) -> rusqlite::Result<Vec<GraphMention>> {
    let project_where = if project_id.is_some() {
        "AND (m.project = ?1 OR e.project = ?2)"
    } else {
        ""
    };
    let sql = format!(
        "SELECT m.id, m.node_id, m.session_id, m.timestamp, m.snippet, e.name
         FROM memory_evidence m
         JOIN memory_nodes e ON e.id = m.node_id
         WHERE m.snippet IS NOT NULL AND length(m.snippet) > 0
         {project_where}
         ORDER BY m.timestamp DESC
         LIMIT {GRAPH_MENTION_LIMIT}"
    );
    let mut statement = connection.prepare(&sql)?;
    let parse_row = |row: &rusqlite::Row<'_>| {
        Ok(GraphMention {
            id: row.get(0)?,
            node_id: row.get(1)?,
            session_id: row.get(2)?,
            timestamp: row.get(3)?,
            snippet: row.get(4)?,
        })
    };
    let rows = if let Some(project_id) = project_id {
        statement.query_map(params![project_id, project_id], parse_row)?
    } else {
        statement.query_map([], parse_row)?
    };
    rows.collect()
}

#[derive(Debug)]
struct GroupedGraphMention {
    id: i64,
    session_id: String,
    timestamp: f64,
    snippet: String,
    entity_ids: Vec<String>,
}

fn group_graph_mentions(mentions: Vec<GraphMention>) -> Vec<LegacyRecallCandidate> {
    let mut grouped = Vec::<GroupedGraphMention>::new();
    let mut by_key = HashMap::<String, usize>::new();
    for mention in mentions {
        let key = format!("{}\0{}", mention.session_id, mention.snippet);
        if let Some(index) = by_key.get(&key).copied() {
            let group = &mut grouped[index];
            group.timestamp = group.timestamp.max(mention.timestamp);
            if !group.entity_ids.contains(&mention.node_id) {
                group.entity_ids.push(mention.node_id);
            }
            continue;
        }
        let index = grouped.len();
        by_key.insert(key, index);
        grouped.push(GroupedGraphMention {
            id: mention.id,
            session_id: mention.session_id,
            timestamp: mention.timestamp,
            snippet: mention.snippet,
            entity_ids: vec![mention.node_id],
        });
    }
    grouped
        .into_iter()
        .map(|mention| LegacyRecallCandidate {
            id: format!("graph:{}", mention.id),
            summary: compact(&mention.snippet, GRAPH_CANDIDATE_SUMMARY_CHARS),
            text: mention.snippet,
            source: LegacyRecallSource::Graph,
            original_source: Some(LegacyRecallOriginalSource::Graph),
            provenance: vec![format!("graph:{}", mention.session_id)],
            related_nodes: mention.entity_ids,
            timestamp: Some(mention.timestamp),
            frequency: Some(1.0),
            explicit_salience: None,
            vector_similarity: None,
            contextual_score: None,
            superseded_by: None,
            contradicts: Vec::new(),
        })
        .collect()
}

fn compact(value: &str, limit: usize) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if crate::public_text::is_js_whitespace(character) {
            pending_space = !normalized.is_empty();
        } else {
            if pending_space {
                normalized.push(' ');
            }
            normalized.push(character);
            pending_space = false;
        }
    }
    let normalized = crate::public_text::trim_js_whitespace(&normalized);
    if normalized.encode_utf16().count() > limit {
        format!("{}...", slice_utf16(normalized, limit))
    } else {
        normalized.to_owned()
    }
}

fn slice_utf16(value: &str, limit: usize) -> String {
    let mut output = String::with_capacity(value.len().min(limit));
    let mut units = 0;
    for character in value.chars() {
        let character_units = character.len_utf16();
        if units + character_units > limit {
            if character_units == 2 && units < limit {
                output.push('\u{fffd}');
            }
            break;
        }
        output.push(character);
        units += character_units;
    }
    output
}
