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
    let mut epics = Vec::new();
    if let Some(plan_id) = &plan {
        let row = read_plan(db, plan_id)?;
        if !project.is_empty() && row["project_id"] != project {
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
        ("?1='' AND", "")
    };
    let status = if done { "" } else { "AND canon_status!='done'" };
    let sql =
        format!("SELECT id FROM canon_epics WHERE {predicate} id>?2 {status} ORDER BY id LIMIT ?3");
    for row in rows(db, &sql, params![value, cursor.after, limit])? {
        epics.push(public::epic(db, text(&row, "id")?)?);
    }
    let more = plans.len() + epics.len() > 100;
    if more {
        epics.pop();
    }
    cursor.after = epics.last().map(|e| e.id.clone()).unwrap_or_default();
    output(plans, epics, more.then_some(cursor))
}
fn output(
    plans: Vec<public::Plan>,
    epics: Vec<public::Epic>,
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
            "SELECT * FROM canon_plans WHERE id>?1 ORDER BY id LIMIT 101",
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
