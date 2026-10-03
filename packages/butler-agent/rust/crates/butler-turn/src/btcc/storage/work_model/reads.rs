use super::*;

pub(super) struct Plan {
    pub scope_id: String,
    pub owner_session_id: String,
    pub id: String,
    pub root_node_id: String,
    pub tier: u8,
    pub graph_revision: u64,
    pub tree_version: u64,
    pub event_seq: u64,
    pub task_count: u64,
    pub edge_count: u64,
    pub spec_count: u64,
    pub status: String,
}

pub(super) fn plan(db: &Connection, session: &str) -> Result<Option<Plan>> {
    db.query_row("SELECT p.id,p.root_node_id,p.tier,p.graph_revision,p.event_seq,p.task_count,p.edge_count,p.spec_count,p.status,p.scope_id,p.owner_session_id,p.tree_version FROM wm_sessions s JOIN wm_plans p ON p.scope_id=s.scope_id AND p.id=s.plan_id WHERE s.session_id=?1",
        [session], |r| Ok(Plan { id:r.get(0)?,root_node_id:r.get(1)?,tier:r.get(2)?,graph_revision:r.get(3)?,
            event_seq:r.get(4)?,task_count:r.get(5)?,edge_count:r.get(6)?,spec_count:r.get(7)?,status:r.get(8)?,scope_id:r.get(9)?,owner_session_id:r.get(10)?,tree_version:r.get(11)? })).optional().map_err(sql)
}

pub(super) fn require_plan(db: &Connection, session: &str) -> Result<Plan> {
    plan(db, session)?.ok_or_else(|| error("spec_required"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Cursor {
    plan: String,
    graph: u64,
    event: u64,
    rank: i64,
    id: String,
}

pub(super) fn page(
    db: &Connection,
    session: &str,
    cursor: Option<&str>,
    graph: bool,
) -> Result<Value> {
    let Some(plan) = plan(db, session)? else {
        return Ok(json!({"tier":0,"total":0,"tasks":[],"counts":{},"next_cursor":null}));
    };
    page_at(db, session, cursor, graph, &plan)
}

pub(super) fn page_plan(db: &Connection, id: &str, cursor: Option<&str>) -> Result<Value> {
    let plan=db.query_row("SELECT p.id,p.root_node_id,p.tier,p.graph_revision,p.event_seq,p.task_count,p.edge_count,p.spec_count,p.status,p.scope_id,p.owner_session_id,p.tree_version FROM wm_plans p WHERE p.id=?1",[id],|r|Ok(Plan{id:r.get(0)?,root_node_id:r.get(1)?,tier:r.get(2)?,graph_revision:r.get(3)?,event_seq:r.get(4)?,task_count:r.get(5)?,edge_count:r.get(6)?,spec_count:r.get(7)?,status:r.get(8)?,scope_id:r.get(9)?,owner_session_id:r.get(10)?,tree_version:r.get(11)?})).map_err(sql)?;
    page_at(db, &plan.owner_session_id, cursor, true, &plan)
}

fn page_at(
    db: &Connection,
    session: &str,
    cursor: Option<&str>,
    graph: bool,
    plan: &Plan,
) -> Result<Value> {
    let cursor: Option<Cursor> = cursor.map(decode).transpose()?;
    if let Some(cursor) = &cursor {
        check(
            cursor.plan == plan.id
                && cursor.graph == plan.graph_revision
                && cursor.event == plan.event_seq,
            "cursor_revision_conflict",
        )?;
    }
    let rank = cursor.as_ref().map_or(-1, |c| c.rank);
    let id = cursor.as_ref().map_or("", |c| c.id.as_str());
    let limit = if graph { 500 } else { 50 };
    let mut statement = db.prepare_cached("SELECT card_json FROM wm_tasks WHERE scope_id=?1 AND plan_id=?2 AND (rank,id)>(?3,?4) ORDER BY rank,id LIMIT ?5").map_err(sql)?;
    let rows = statement
        .query_map(params![plan.scope_id, plan.id, rank, id, limit + 1], |r| {
            r.get::<_, String>(0)
        })
        .map_err(sql)?;
    let mut tasks = rows
        .map(|row| decode::<TaskCard>(&row.map_err(sql)?))
        .collect::<Result<Vec<_>>>()?;
    let more = tasks.len() > limit;
    if more {
        tasks.pop();
    }
    let next = if more {
        tasks
            .last()
            .map(|t| {
                encode(&Cursor {
                    plan: plan.id.clone(),
                    graph: plan.graph_revision,
                    event: plan.event_seq,
                    rank: t.rank,
                    id: t.id.clone(),
                })
            })
            .transpose()?
    } else {
        None
    };
    let counts = counts(db, plan)?;
    let mut value = json!({"tier":plan.tier,"plan_id":plan.id,"root_node_id":plan.root_node_id,
        "graph_revision":plan.graph_revision,"tree_version":plan.tree_version,"event_seq":plan.event_seq,"status":plan.status,
        "total":plan.task_count,"spec_count":plan.spec_count,"counts":counts,"tasks":tasks,"next_cursor":next});
    details(db, plan, session, &tasks, &mut value)?;
    if graph {
        set(
            &mut value,
            "edges",
            json!(edges_for_page(db, &plan.scope_id, &plan.id, &tasks)?),
        )?;
        set(&mut value, "edge_total", json!(plan.edge_count))?;
    }
    Ok(value)
}

fn edges_for_page(
    db: &Connection,
    scope: &str,
    plan: &str,
    tasks: &[TaskCard],
) -> Result<Vec<Edge>> {
    let ids = tasks.iter().map(|t| &t.id).collect::<Vec<_>>();
    let mut statement = db.prepare_cached("SELECT e.predecessor,e.successor FROM json_each(?3) ids CROSS JOIN wm_edges e ON e.scope_id=?1 AND e.plan_id=?2 AND e.predecessor=ids.value ORDER BY e.predecessor,e.successor").map_err(sql)?;
    let edges = statement
        .query_map(params![scope, plan, encode(&ids)?], |r| {
            Ok(Edge {
                from: r.get(0)?,
                to: r.get(1)?,
            })
        })
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    Ok(edges)
}

pub(super) fn ancestors(db: &Connection, session: &str, node: &str) -> Result<Vec<SpecRef>> {
    let plan = require_plan(db, session)?;
    let mut current = Some(node.to_owned());
    let mut nodes = Vec::new();
    while let Some(node) = current {
        check(
            u64::try_from(nodes.len()).map_err(|_| error("spec_tree_integrity_error"))?
                <= plan.spec_count,
            "spec_tree_integrity_error",
        )?;
        let (reference, parent): (String,Option<String>) = db.query_row(
            "SELECT r.reference_json,t.parent_id FROM wm_tree t JOIN wm_specs r ON r.scope_id=t.scope_id AND r.node_id=t.node_id AND r.node_revision=t.node_revision WHERE t.scope_id=?1 AND t.plan_id=?2 AND t.node_id=?3",
            params![plan.scope_id,plan.id,node], |r| Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
        nodes.push(decode(&reference)?);
        current = parent;
    }
    Ok(nodes)
}

fn counts(db: &Connection, plan: &Plan) -> Result<serde_json::Map<String, Value>> {
    let mut counts = serde_json::Map::new();
    let mut statement = db
        .prepare_cached(
            "SELECT status,total FROM wm_counts WHERE scope_id=?1 AND plan_id=?2 ORDER BY status",
        )
        .map_err(sql)?;
    for row in statement
        .query_map(params![plan.scope_id, plan.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })
        .map_err(sql)?
    {
        let (status, total) = row.map_err(sql)?;
        counts.insert(status, json!(total));
    }
    Ok(counts)
}

fn details(
    db: &Connection,
    plan: &Plan,
    session: &str,
    tasks: &[TaskCard],
    value: &mut Value,
) -> Result<()> {
    let root:String=db.query_row("SELECT r.reference_json FROM wm_tree t JOIN wm_specs r ON r.scope_id=t.scope_id AND r.node_id=t.node_id AND r.node_revision=t.node_revision WHERE t.scope_id=?1 AND t.plan_id=?2 AND t.node_id=?3",params![plan.scope_id,plan.id,plan.root_node_id],|r|r.get(0)).map_err(sql)?;
    value["root_spec_ref"] = decode(&root)?;
    let (current,reason,policy):(Option<String>,String,u64)=db.query_row("SELECT current_task_id,routing_reason,policy_revision FROM wm_sessions WHERE session_id=?1 AND plan_id=?2",params![session,plan.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sql)?.unwrap_or_else(||(None,"historical_plan".into(),1));
    value["current_task_id"] = json!(current);
    value["current_task"] = json!(
        current
            .map(|id| tasks::load(db, &plan.scope_id, &plan.id, &id))
            .transpose()?
    );
    value["routing_reason"] = json!(reason);
    value["policy_revision"] = json!(policy);
    let phase: String = db
        .query_row(
            "SELECT phase FROM wm_plans WHERE scope_id=?1 AND id=?2",
            params![plan.scope_id, plan.id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    value["phase"] = json!(phase);
    let selected: Option<String> = db
        .query_row(
            "SELECT selected_task_id FROM wm_sessions WHERE session_id=?1 AND plan_id=?2",
            params![session, plan.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?
        .flatten();
    value["selected_task_id"] = json!(selected);
    let ids = tasks
        .iter()
        .map(|t| &t.work_id)
        .collect::<std::collections::HashSet<_>>();
    let mut stmt=db.prepare_cached("SELECT w.id,w.rank,w.status,w.binding_json,r.reference_json FROM json_each(?3) ids JOIN wm_works w ON w.id=ids.value JOIN wm_specs r ON r.scope_id=w.scope_id AND r.node_id=w.node_id AND r.node_revision=w.node_revision WHERE w.scope_id=?1 AND w.plan_id=?2 ORDER BY w.rank,w.id").map_err(sql)?;
    let rows = stmt
        .query_map(params![plan.scope_id, plan.id, encode(&ids)?], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(sql)?;
    value["works"]=json!(rows.map(|row|{let(id,rank,status,binding,reference)=row.map_err(sql)?;Ok(json!({"id":id,"rank":rank,"status":status,"binding":decode::<Value>(&binding)?,"spec_ref":decode::<Value>(&reference)?}))}).collect::<Result<Vec<_>>>()?);
    let receipt: Option<String> = db
        .query_row(
            "SELECT result_json FROM wm_audit WHERE seq=?1",
            [plan.event_seq],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    value["latest_receipt"] = receipt
        .map(|r| decode::<Value>(&r))
        .transpose()?
        .unwrap_or(Value::Null);
    value["blocked_reason"] = butler_core::json::at(value, "/current_task/blocked_reason").clone();
    provenance(db, plan, value)?;
    Ok(())
}

fn provenance(db: &Connection, plan: &Plan, value: &mut Value) -> Result<()> {
    let metadata: String = db.query_row(
        "SELECT json_object('id',id,'revision',revision,'title',objective,'author',owner_session_id,'origin_instruction_id',instruction_id,'scope',json_object('session_id',scope_id),'created_at',created_at,'updated_at',updated_at) FROM wm_plans WHERE scope_id=?1 AND id=?2",
        params![plan.scope_id,plan.id], |r|r.get(0)
    ).map_err(sql)?;
    let metadata: serde_json::Map<String, Value> = decode(&metadata)?;
    value
        .as_object_mut()
        .ok_or_else(|| error("work_model_encoding_failed"))?
        .extend(metadata);
    if let Some(works) = value["works"].as_array_mut() {
        for work in works {
            let id = work["id"]
                .as_str()
                .ok_or_else(|| error("work_model_integrity_error"))?;
            let metadata:String=db.query_row("SELECT json_object('revision',w.revision,'title',w.outcome,'author',p.owner_session_id,'origin_instruction_id',p.instruction_id,'scope',json_object('session_id',w.scope_id),'created_at',w.created_at,'updated_at',w.updated_at) FROM wm_works w JOIN wm_plans p ON p.scope_id=w.scope_id AND p.id=w.plan_id WHERE w.scope_id=?1 AND w.plan_id=?2 AND w.id=?3",params![plan.scope_id,plan.id,id],|r|r.get(0)).map_err(sql)?;
            let metadata: serde_json::Map<String, Value> = decode(&metadata)?;
            work.as_object_mut()
                .ok_or_else(|| error("work_model_encoding_failed"))?
                .extend(metadata);
        }
    }
    Ok(())
}
