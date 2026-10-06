//! Revision-bound read pages and task document exports. Viewing has no writes.
use super::super::{AppTaskGraphQuery, GatewayApplicationError};
use super::*;
use butler_turn::btcc::{TaskGraphScope as GraphScope, decode_task_graph_id as decode};

pub fn task_graph_response(
    mut graphs: Vec<Value>,
    query: &AppTaskGraphQuery,
) -> Result<Value, GatewayApplicationError> {
    if matches!(&query.scope, GraphScope::Session(_)) {
        let revision = super::digest(
            &json!(graphs.iter().map(|g| summary(g, false)).collect::<Vec<_>>()).to_string(),
        );
        validate_revision(query.revision.as_deref(), &revision)?;
        let after = cursor(query, &revision)?;
        let total = graphs.len();
        let summaries: Vec<_> = graphs
            .iter()
            .map(|g| summary(g, query.include_nodes))
            .collect();
        let page = page(
            summaries,
            after.as_deref(),
            query.limit,
            &revision,
            "graph_id",
        )?;
        return Ok(
            json!({"graphs":page.0,"cursor":page.1,"graph_revision":revision,"total":total,"event_seq":0}),
        );
    }
    let Some(mut graph) = graphs.pop() else {
        return Err(missing());
    };
    let revision = graph["graph_revision"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?
        .to_owned();
    validate_revision(query.revision.as_deref(), &revision)?;
    if let GraphScope::Task(task) = &query.scope {
        let node = graph["nodes"]
            .as_array()
            .and_then(|nodes| nodes.iter().find(|n| n["task_id"] == *task))
            .ok_or_else(missing)?;
        return Ok(document(node, &graph));
    }
    let after = cursor(query, &revision)?;
    let nodes = graph["nodes"]
        .as_array_mut()
        .ok_or_else(GatewayApplicationError::internal)?;
    let total = nodes.len();
    strip_hidden(nodes);
    let mut ordered = nodes.clone();
    // Keyset order is the immutable plan order, followed by exact task identity.
    for (index, node) in ordered.iter_mut().enumerate() {
        node["_cursor"] = json!(format!(
            "{index:020}:{}",
            node["task_id"].as_str().unwrap_or("")
        ));
    }
    let (mut nodes, next) = page(ordered, after.as_deref(), query.limit, &revision, "_cursor")?;
    for node in &mut nodes {
        if let Some(object) = node.as_object_mut() {
            object.remove("_cursor");
        }
    }
    graph["nodes"] = json!(nodes);
    graph["cursor"] = json!(next);
    graph["totals"] = json!({"nodes":total,"edges":graph["edges"].as_array().map_or(0,Vec::len)});
    graph["event_seq"] = json!(0);
    Ok(graph)
}

fn summary(graph: &Value, include_nodes: bool) -> Value {
    let mut value = json!({"graph_id":graph["graph_id"],"title":graph["title"],"state":graph["state"],"counts":graph["counts"],"graph_revision":graph["graph_revision"],"updated_at":graph["updated_at"]});
    if include_nodes {
        let mut nodes = graph["nodes"].clone();
        if let Some(nodes) = nodes.as_array_mut() {
            strip_hidden(nodes);
        }
        value["nodes"] = nodes;
        value["edges"] = graph["edges"].clone();
    }
    value
}
fn strip_hidden(nodes: &mut [Value]) {
    for node in nodes {
        if let Some(object) = node.as_object_mut() {
            object.retain(|key, _| !key.starts_with('_'));
        }
    }
}

fn validate_revision(expected: Option<&str>, actual: &str) -> Result<(), GatewayApplicationError> {
    if expected.is_some_and(|r| r != actual) {
        return Err(conflict());
    }
    Ok(())
}
fn cursor(
    query: &AppTaskGraphQuery,
    revision: &str,
) -> Result<Option<String>, GatewayApplicationError> {
    let Some(cursor) = query.cursor.as_deref() else {
        return Ok(None);
    };
    let (bound, key) = decode(cursor, "cursor:").ok_or_else(conflict)?;
    validate_revision(Some(&bound), revision)?;
    Ok(Some(key))
}
fn page(
    values: Vec<Value>,
    after: Option<&str>,
    limit: usize,
    revision: &str,
    key: &str,
) -> Result<(Vec<Value>, Option<String>), GatewayApplicationError> {
    let start = if let Some(after) = after {
        values
            .iter()
            .position(|v| v[key] == after)
            .map(|i| i + 1)
            .ok_or_else(conflict)?
    } else {
        0
    };
    let end = start.saturating_add(limit.max(1)).min(values.len());
    let next = (end < values.len()).then(|| {
        encode(
            "cursor:",
            revision,
            values[end - 1][key].as_str().unwrap_or(""),
        )
    });
    Ok((
        values.into_iter().skip(start).take(end - start).collect(),
        next,
    ))
}
fn document(node: &Value, graph: &Value) -> Value {
    let mut markdown = format!(
        "---\nid: {}\nstatus: {}\nparent: {}\nowner: {}\n---\n\n# {}\n\n## Goal\n{}\n\n## Done criteria\n",
        node["task_id"].as_str().unwrap_or(""),
        node["status"].as_str().unwrap_or(""),
        node["_refs"][0].as_str().unwrap_or(""),
        node["assignee_ordinal"],
        node["title"].as_str().unwrap_or("Task"),
        node["_goal"].as_str().unwrap_or("Task")
    );
    for criterion in node["_checks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        markdown.push_str(&format!("- {criterion}\n"));
    }
    markdown.push_str("\n## Predecessors\n");
    for edge in graph["edges"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["to"] == node["task_id"])
    {
        if let Some(before) = graph["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|n| n["task_id"] == edge["from"])
        {
            markdown.push_str(&format!(
                "- {} ({})\n",
                before["title"].as_str().unwrap_or("Task"),
                before["task_id"].as_str().unwrap_or("")
            ));
        }
    }
    json!({"id":node["task_id"],"kind":"plan","document_type":"task","title":node["title"],"status":node["status"],"revision":graph["graph_revision"],"safe_path_label":"Task document","source_label":"Task document","markdown":markdown,"updated_at":graph["updated_at"],"spec_ref":node["_refs"][0]})
}
fn missing() -> GatewayApplicationError {
    GatewayApplicationError::public(404, "task_graph_not_found", "Task graph is unavailable.")
}
fn conflict() -> GatewayApplicationError {
    GatewayApplicationError::public(
        409,
        "task_graph_resync_required",
        "Task graph changed; reload it.",
    )
}
