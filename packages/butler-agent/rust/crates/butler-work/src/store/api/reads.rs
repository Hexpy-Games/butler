use super::*;
use rusqlite::params;

pub fn queue(db: &Connection, session: &str) -> Result<Value> {
    let work = read_work(db, session)?;
    let mut chains = rows(db, sql::CHAINS, [session])?;
    for chain in &mut chains {
        let id = text(chain, "id")?;
        let stored = load_chain(db, id)?;
        let holds = undecided_holds(db, id)?;
        let ready = ready_tasks(db, id)?;
        let steps: Vec<_> = stored
            .chain
            .steps
            .iter()
            .map(|step| {
                let works: Vec<_> = stored
                    .members
                    .iter()
                    .filter(|w| w["step_index"] == step.index)
                    .cloned()
                    .collect();
                json!({"index":step.index,"tasks":works})
            })
            .collect();
        chain["steps"] = json!(steps);
        chain["hold_questions"] = json!(holds);
        chain["ready_task_ids"] = json!(ready);
    }
    Ok(json!({"work_id":session,"task_graph_revision":work["task_graph_revision"],"chains":chains}))
}
fn cards(db: &Connection, plan: Option<&str>, project: &str) -> Result<Vec<Value>> {
    let query = if plan.is_some() {
        Query::PlanOverview
    } else {
        Query::Backlog
    };
    let mut works = rows(db, query.sql(), [plan.unwrap_or(project)])?;
    for work in &mut works {
        let counts = progress(db, text(work, "id")?)?;
        work["task_counts"] = counts;
        work["draft"] = json!(work["draft"] == 1);
    }
    Ok(works)
}
fn progress(db: &Connection, work: &str) -> Result<Value> {
    let mut counts = serde_json::Map::new();
    let mut total = 0;
    let mut stmt = db.prepare(Query::TaskProgress.sql())?;
    let pairs = stmt.query_map([work], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    for pair in pairs {
        let (status, count) = pair?;
        total += count;
        counts.insert(status, json!(count));
    }
    counts.insert("total".into(), json!(total));
    Ok(Value::Object(counts))
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
    work["tasks"] = json!(rows(db, Query::TaskList.sql(), [id])?);
    work["task_counts"] = progress(db, id)?;
    Ok(public_work(work))
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

fn public_work(mut work: Value) -> Value {
    work["draft"] = json!(work["draft"] == 1);
    work
}

/// Chain creation, step and stack order are the single nested-session order.
pub(super) fn session_works(db: &Connection, session: &str) -> Result<Value> {
    let mut works = rows(db, Query::SessionWorks.sql(), [session])?;
    for work in &mut works {
        work["tasks"] = queue(db, text(work, "id")?)?;
    }
    Ok(json!({"works":works}))
}
