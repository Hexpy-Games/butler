use super::*;
use rusqlite::{Connection, params};
use std::collections::{HashMap, HashSet};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Order {
    pub group_key: String,
    work_ids: Vec<String>,
}
pub(super) fn parse(value: Value) -> Result<Order, GatewayApplicationError> {
    serde_json::from_value(value).map_err(|_| public(400, "work_model_invalid", "Invalid order."))
}
pub(super) fn validate(canon: &Value, input: &Order) -> Result<(), GatewayApplicationError> {
    let wanted: HashSet<_> = input.work_ids.iter().map(String::as_str).collect();
    if wanted.len() != input.work_ids.len() {
        return Err(public(400, "work_model_invalid", "Invalid order."));
    }
    let rows = if input.group_key == "backlog" {
        Some(&canon["backlog"])
    } else {
        canon["plans"]
            .as_array()
            .and_then(|plans| plans.iter().find(|p| p["id"] == input.group_key))
            .map(|p| &p["works"])
    }
    .and_then(Value::as_array)
    .ok_or_else(|| public(409, "conflict", "Group no longer exists."))?;
    let actual: HashSet<_> = rows
        .iter()
        .filter(|w| visible(w))
        .filter_map(|w| w["id"].as_str())
        .collect();
    if actual != wanted {
        let revision = if input.group_key == "backlog" {
            canon["backlog_revision"].as_i64()
        } else {
            canon["plans"]
                .as_array()
                .and_then(|plans| plans.iter().find(|p| p["id"] == input.group_key))
                .and_then(|p| p["revision"].as_i64())
        }
        .ok_or_else(GatewayApplicationError::internal)?;
        return Err(GatewayApplicationError::Public {
            status: 409,
            code: "conflict".into(),
            message: "Group membership changed.".into(),
            source: Some(std::sync::Arc::new(AppCanonConflict { revision })),
        });
    }
    Ok(())
}
fn visible(work: &Value) -> bool {
    work["sessions"].as_array().is_some_and(|s| !s.is_empty()) || work["assignee"] == APP_PERSON_ID
}
pub(super) fn replace(
    db: &Connection,
    project: &str,
    order: &Order,
) -> Result<(), AppStorageError> {
    db.execute(
        "DELETE FROM app_canon_sidebar_order WHERE project_id=?1 AND group_key=?2",
        params![project, order.group_key],
    )
    .map_err(AppStorageError::sqlite)?;
    for (position, work) in order.work_ids.iter().enumerate() {
        db.execute("INSERT INTO app_canon_sidebar_order(project_id,group_key,work_id,position) VALUES(?1,?2,?3,?4)",
            params![project,order.group_key,work,format!("{position:020}")]).map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}
pub(super) fn view(
    db: &Connection,
    project: &str,
    mut canon: Value,
) -> Result<Value, AppStorageError> {
    let mut groups = vec![json!({"key":"backlog","kind":"backlog","rows":canon["backlog"].take()})];
    if let Some(plans) = canon["plans"].as_array_mut() {
        for plan in plans {
            groups.push(json!({"key":plan["id"],"kind":"plan","title":plan["title"],
                "plan_revision":plan["revision"],"rows":plan["works"].take()}));
        }
    }
    for group in &mut groups {
        let key = group["key"].as_str().unwrap_or_default();
        let mut statement = db.prepare("SELECT work_id FROM app_canon_sidebar_order WHERE project_id=?1 AND group_key=?2 ORDER BY position").map_err(AppStorageError::sqlite)?;
        let personal = statement
            .query_map(params![project, key], |r| r.get::<_, String>(0))
            .map_err(AppStorageError::sqlite)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(AppStorageError::sqlite)?;
        let positions: HashMap<_, _> = personal
            .into_iter()
            .enumerate()
            .map(|(i, id)| (id, i))
            .collect();
        if let Some(rows) = group["rows"].as_array_mut() {
            rows.retain(visible);
            rows.sort_by_key(|w| {
                positions
                    .get(w["id"].as_str().unwrap_or_default())
                    .copied()
                    .unwrap_or(usize::MAX)
            });
        }
    }
    Ok(json!({"project_id":project,"groups":groups}))
}
