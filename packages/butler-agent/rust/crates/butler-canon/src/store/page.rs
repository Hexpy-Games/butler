//! Indexed keyset pagination. Cursors bind to the complete filter.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::params;
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Cursor {
    project: String,
    plan: Option<String>,
    done: bool,
    phase: u8,
    after: String,
}

pub fn list(db: &Connection, project: &str, input: &Value) -> Result<Value> {
    let plan = input["plan_id"].as_str().map(str::to_owned);
    let done = input["include_done"].as_bool().unwrap_or(false);
    let mut cursor = Cursor {
        project: project.into(),
        plan: plan.clone(),
        done,
        ..Default::default()
    };
    if let Some(encoded) = input["cursor"].as_str() {
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| Error::Invalid("invalid cursor"))?;
        let old: Cursor =
            serde_json::from_slice(&decoded).map_err(|_| Error::Invalid("invalid cursor"))?;
        if old.project != project || old.plan != plan || old.done != done {
            return Err(Error::Invalid("cursor filters changed"));
        }
        cursor = old;
    }
    let mut plans = Vec::new();
    let epics = Vec::new();
    if let Some(plan_id) = &plan {
        let row = read_plan(db, plan_id)?;
        let active = db
            .query_row(
                "SELECT archived=0 FROM projects WHERE id=?1",
                [text(&row, "project_id")?],
                |r| r.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false);
        if !active || (!project.is_empty() && row["project_id"] != project) {
            return Err(Error::NotFound);
        }
    }
    if cursor.phase == 0 {
        plans = plans_page(db, project, plan.as_deref(), &cursor.after)?;
        if plans.len() > 100 {
            plans.truncate(100);
            cursor.after = plans.last().map(|p| p.id.clone()).unwrap_or_default();
            return output(plans, epics, Some(cursor));
        }
        cursor.phase = 1;
        cursor.after.clear();
    }
    let limit = 101 - plans.len();
    let (predicate, value) = if let Some(plan) = &plan {
        ("plan_id=?1 AND", plan.as_str())
    } else if !project.is_empty() {
        ("project_id=?1 AND", project)
    } else {
        (
            "?1='' AND EXISTS (SELECT 1 FROM projects WHERE id=canon_epics.project_id AND archived=0) AND",
            "",
        )
    };
    let status = if done { "" } else { "AND canon_status!='done'" };
    let mut epics = epics_page(db, predicate, status, value, &cursor.after, limit)?;
    let more = plans.len() + epics.len() > 100;
    if more {
        epics.pop();
    }
    cursor.after = epics.last().map(|e| e.id.clone()).unwrap_or_default();
    output(plans, epics, more.then_some(cursor))
}
fn output(
    plans: Vec<public::Plan>,
    epics: Vec<public::EpicSummary>,
    cursor: Option<Cursor>,
) -> Result<Value> {
    let cursor = cursor
        .map(|c| serde_json::to_vec(&c).map(|v| URL_SAFE_NO_PAD.encode(v)))
        .transpose()?;
    Ok(serde_json::to_value(public::Page {
        plans,
        epics,
        cursor,
    })?)
}

fn plans_page(
    db: &Connection,
    project: &str,
    plan: Option<&str>,
    after: &str,
) -> Result<Vec<public::Plan>> {
    let found = if let Some(plan) = plan {
        rows(db, "SELECT * FROM canon_plans WHERE id=?1", [plan])?
    } else if project.is_empty() {
        rows(
            db,
            "SELECT * FROM canon_plans WHERE id>?1 AND EXISTS (SELECT 1 FROM projects WHERE id=canon_plans.project_id AND archived=0) ORDER BY id LIMIT 101",
            [after],
        )?
    } else {
        rows(
            db,
            "SELECT * FROM canon_plans WHERE project_id=?1 AND id>?2 ORDER BY id LIMIT 101",
            params![project, after],
        )?
    };
    Ok(found
        .into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<_, _>>()?)
}

fn epics_page(
    db: &Connection,
    predicate: &str,
    status: &str,
    value: &str,
    after: &str,
    limit: usize,
) -> Result<Vec<public::EpicSummary>> {
    let sql = format!("SELECT e.id,e.title,e.canon_status AS status,e.revision,e.assignee,e.updated_at,p.id AS plan_id,p.title AS plan_title
        FROM (SELECT * FROM canon_epics WHERE {predicate} id>?2 {status} ORDER BY id LIMIT ?3) e
        LEFT JOIN canon_plans p ON p.id=e.plan_id ORDER BY e.id");
    let found = rows(db, &sql, params![value, after, limit])?;
    let ids = json!(found.iter().map(|r| &r["id"]).collect::<Vec<_>>()).to_string();
    let mut tags = std::collections::HashMap::<String, Vec<public::Tag>>::new();
    for mut row in rows(
        db,
        "SELECT a.epic_id,t.id,t.name,t.color FROM json_each(?1) ids JOIN canon_epic_tags a ON a.epic_id=ids.value JOIN canon_tags t ON t.id=a.tag_id ORDER BY t.name_key",
        [ids],
    )? {
        let epic = text(&row, "epic_id")?.to_owned();
        if let Some(object) = row.as_object_mut() {
            object.remove("epic_id");
        }
        tags.entry(epic)
            .or_default()
            .push(serde_json::from_value(row)?);
    }
    found
        .into_iter()
        .map(|mut row| {
            row["plan"] = if row["plan_id"].is_null() {
                Value::Null
            } else {
                json!({"id":row["plan_id"],"title":row["plan_title"]})
            };
            row["tags"] = serde_json::to_value(tags.remove(text(&row, "id")?).unwrap_or_default())?;
            Ok(serde_json::from_value(row)?)
        })
        .collect()
}
