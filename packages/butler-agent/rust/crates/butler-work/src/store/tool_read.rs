//! Complete, snapshot-bound reads. Reads never select a different session's Work.
pub mod sql;
use super::*;
use rusqlite::params;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {
    pub view: View,
    pub work_id: Option<String>,
    pub task_id: Option<String>,
    pub node_id: Option<String>,
    pub revision: Option<String>,
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum View {
    Summary,
    Tasks,
    Task,
    Spec,
    Coverage,
    Operations,
}

pub fn bound_work(
    db: &Connection,
    session: &str,
    requested: Option<&str>,
) -> Result<Option<Value>> {
    if let Some(id) = requested {
        let work = read_work(db, id)?;
        authorize(db, session, &work)?;
        return Ok(Some(work));
    }
    for statement in [sql::CURRENT, sql::PART_WORK] {
        match one(db, statement, [session]) {
            Ok(row) => return read_work(db, text(&row, "work_id")?).map(Some),
            Err(Error::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    match one(db, sql::HOME, [session]) {
        Ok(row) => Ok(Some(row)),
        Err(Error::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}
fn authorize(db: &Connection, session: &str, work: &Value) -> Result<()> {
    if work["home_session_id"] == session
        || work["scope_kind"] == "session" && work["scope_ref"] == session
    {
        return Ok(());
    }
    for statement in [sql::OWNED_TASK, sql::OWNED_PART] {
        match one(db, statement, params![session, text(work, "id")?]) {
            Ok(_) => return Ok(()),
            Err(Error::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    Err(Error::Invalid("Work is outside the bound session"))
}

pub fn read(
    db: &Connection,
    session: &str,
    input: &Read,
    tier: u8,
    planning: bool,
) -> Result<Value> {
    if input.cursor.is_some() {
        return Err(Error::Invalid(
            "unknown Work cursor; this view returns the complete snapshot",
        ));
    }
    let work = bound_work(db, session, input.work_id.as_deref())?;
    let tier = match &work {
        Some(work) => tier.max(
            u8::try_from(work["tier"].as_u64().ok_or(Error::Invalid("tier"))?)
                .map_err(|_| Error::Invalid("tier"))?,
        ),
        None => tier,
    };
    let graph = work
        .as_ref()
        .map(|work| work["task_graph_revision"].clone());
    let view = match (&work, input.view) {
        (_, View::Operations) => {
            return Ok(json!({"ok":true,
            "operations":operations(tier,planning,work.is_some()),"work":work,"remaining":0}));
        }
        (None, _) => return Ok(json!({"ok":true,"work":null,"remaining":0})),
        (Some(work), View::Summary) => summary(db, work)?,
        (Some(work), View::Tasks) => api::queue(db, text(work, "id")?)?,
        (Some(work), View::Task) => task(
            db,
            text(work, "id")?,
            input
                .task_id
                .as_deref()
                .ok_or(Error::Invalid("task_id required for view=task"))?,
        )?,
        (Some(work), View::Spec | View::Coverage) => spec(db, work, input)?,
    };
    Ok(json!({"ok":true,"view":view,"task_graph_revision":graph,"remaining":0}))
}

fn summary(db: &Connection, work: &Value) -> Result<Value> {
    let counts = db
        .prepare(crate::work_queries::Query::TaskProgress.sql())?
        .query_map([text(work, "id")?], |row| {
            Ok(json!({
                "status":row.get::<_,String>(0)?,"count":row.get::<_,i64>(1)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({"work":work,"task_counts":counts}))
}
fn task(db: &Connection, work: &str, id: &str) -> Result<Value> {
    let task = read_task(db, id)?;
    if task["work_id"] != work {
        return Err(Error::NotFound);
    }
    let mut results = rows(db, execution::sql::RESULTS, [id])?;
    for result in &mut results {
        result["content"] = json!(body(db, text(result, "body_ref")?)?);
    }
    Ok(
        json!({"task":task,"parts":parts::task_parts(db,id)?,"part_edges":parts::part_edges(db,id)?,
        "attempts":rows(db,execution::sql::ATTEMPTS,[id])?,"criteria":rows(db,execution::sql::CRITERIA,[id])?,
        "results":results,"reviews":rows(db,sql::REVIEWS,[id])?}),
    )
}
fn spec(db: &Connection, work: &Value, input: &Read) -> Result<Value> {
    let id = input
        .node_id
        .as_deref()
        .or(work["spec_node_id"].as_str())
        .ok_or(Error::Invalid("no responsible Spec node"))?;
    let node = one(db, super::sql::NODE, [id])?;
    if node["work_id"] != work["id"] {
        return Err(Error::NotFound);
    }
    let revision = match &input.revision {
        Some(revision) => revision
            .parse::<i64>()
            .map_err(|_| Error::Invalid("Spec revision must be an integer"))?,
        None => node["active_revision"]
            .as_i64()
            .ok_or(Error::Invalid("Spec is not active"))?,
    };
    let published = one(db, super::sql::SPEC_REVISION, params![id, revision])?;
    let mut criteria = rows(db, api::sql::SPEC_CRITERIA, params![id, revision])?;
    if matches!(input.view, View::Coverage) {
        for criterion in &mut criteria {
            criterion["tasks"] = json!(rows(
                db,
                crate::work_queries::Query::CriterionConsumers.sql(),
                params![id, revision, text(criterion, "criterion_id")?]
            )?);
        }
    }
    Ok(
        json!({"node":node,"published":published,"body":body(db,text(&published,"body_hash")?)?,"criteria":criteria}),
    )
}
pub fn body(db: &Connection, hash: &str) -> Result<String> {
    let encoded: Vec<u8> = db.query_row(sql::BODY, [hash], |r| r.get(0))?;
    let decoded = zstd::stream::decode_all(encoded.as_slice()).map_err(Error::BodyCodec)?;
    String::from_utf8(decoded).map_err(|_| Error::Invalid("Spec body is not UTF-8"))
}

pub fn operations(tier: u8, planning: bool, bound: bool) -> Value {
    let mut available = Vec::new();
    if bound {
        available.extend([
            "task.add",
            "task.edit",
            "task.move",
            "task.delete",
            "part.add",
            "part.edit",
            "part.remove",
            "work.escalate",
            "spec.propose",
            "spec.activate",
        ]);
        if tier == 2 {
            available.extend(["task.join_stack", "task.split_stack"]);
        }
        if !planning {
            available.extend([
                "task.start",
                "part.start",
                "task.submit",
                "task.review",
                "task.complete",
                "task.block",
                "task.fail",
            ]);
        }
    } else {
        available.push("work.create_light");
        available.push("task.add");
        available.push("task.start");
        if tier == 2 {
            available.extend(["spec.propose", "spec.activate"]);
        }
    }
    json!({"available":available,"unavailable_reason":if planning {"Execution is hidden during planning."} else if tier < 2 {"Delegation and full Spec authoring require Tier 2."} else {"Only in-scope variants are permitted."}})
}
