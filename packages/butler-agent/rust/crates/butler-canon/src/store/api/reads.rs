use super::*;
use rusqlite::params;

fn cards(db: &Connection, plan: Option<&str>, project: &str) -> Result<Vec<Value>> {
    let query = if plan.is_some() {
        Query::PlanOverview
    } else {
        Query::Backlog
    };
    let mut works = rows(db, query.sql(), [plan.unwrap_or(project)])?;
    for work in &mut works {
        *work = public_work(db, work.take())?;
    }
    Ok(works)
}
pub(super) fn backlog_revision(db: &Connection, project: &str) -> Result<i64> {
    Ok(db
        .query_row(sql::BACKLOG_REVISION, [project], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}
pub fn canon(db: &Connection, project: &str) -> Result<Value> {
    let mut plans = rows(db, sql::PLANS, [project])?;
    for plan in &mut plans {
        plan["works"] = json!(cards(db, Some(text(plan, "id")?), project)?);
    }
    Ok(
        json!({"project_id":project,"backlog_revision":backlog_revision(db,project)?,
        "backlog":cards(db,None,project)?,"plans":plans}),
    )
}
pub fn plan(db: &Connection, id: &str) -> Result<Value> {
    let mut plan = canon_row(read_plan(db, id)?)?;
    let works = cards(db, Some(id), text(&plan, "project_id")?)?;
    let completed = works.iter().filter(|w| w["canon_status"] == "done").count();
    plan["progress"] = json!({"total":works.len(),"done":completed});
    plan["works"] = json!(works);
    Ok(plan)
}
pub fn epic(db: &Connection, id: &str) -> Result<Value> {
    let mut work = canon_row(read_work(db, id)?)?;
    let nodes = rows(db, Query::WorkSpecNodes.sql(), [id])?;
    work["specs"] = json!(spec_tree(db, &nodes, None)?);
    public_work(db, work)
}
fn spec_tree(db: &Connection, nodes: &[Value], parent: Option<&str>) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for node in nodes
        .iter()
        .filter(|n| n["parent_node_id"].as_str() == parent)
    {
        let id = text(node, "node_id")?;
        let mut node = node.clone();
        node["active"] = if let Some(rev) = node["active_revision"].as_i64() {
            one(db, super::super::sql::SPEC_REVISION, params![id, rev])?
        } else {
            Value::Null
        };
        node["criteria"] = json!(rows(
            db,
            sql::SPEC_CRITERIA,
            params![id, node["active_revision"].as_i64()]
        )?);
        node["children"] = json!(spec_tree(db, nodes, Some(id))?);
        result.push(node);
    }
    Ok(result)
}

fn public_work(db: &Connection, mut work: Value) -> Result<Value> {
    let sessions = rows(db, super::super::sql::EPIC_SESSIONS, [text(&work, "id")?])?;
    work["home_session_id"] = sessions
        .iter()
        .find(|s| s["is_home"] == 1)
        .map(|s| s["session_id"].clone())
        .unwrap_or(Value::Null);
    work["session_ids"] = json!(
        sessions
            .iter()
            .map(|s| &s["session_id"])
            .collect::<Vec<_>>()
    );
    work["sessions"] = json!(sessions);
    work["tags"] = json!(rows(db, sql::EPIC_TAGS, [text(&work, "id")?])?);
    // Empty progress until the link/progress branch supplies the derived view.
    work["tasks"] = json!([]);
    work["task_counts"] = json!({"total":0});
    Ok(work)
}
