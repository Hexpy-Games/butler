//! Multi-operation apply calls the same CAS writers as the board.
use super::*;
use crate::store::api::{Resource, project_scope, read, write};

pub(super) fn execute(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    change: &Value,
) -> Result<Value> {
    let op = text(change, "op")?;
    if op == "project.create" {
        return Ok(json!({"op":op,"project_id":project}));
    }
    if op == "spec.edit" {
        return super::specs::edit(tx, ctx, project, change);
    }
    let resource = match op {
        "epic.create" => Resource::CreateEpic,
        "epic.delete" => Resource::DeleteEpic,
        "epic.edit" | "epic.move" => Resource::EditEpic,
        "plan.create" => Resource::CreatePlan,
        "plan.edit" => Resource::EditPlan,
        "plan.reorder" => {
            if change["id"].is_null() {
                Resource::BacklogOrder
            } else {
                Resource::PlanOrder
            }
        }
        _ => return Err(Error::Invalid("unknown canon operation")),
    };
    let id = change["id"].as_str().unwrap_or(project);
    if project_scope(tx, resource, id)? != project {
        return Err(Error::Invalid("operation outside project"));
    }
    let mut fields = change
        .as_object()
        .cloned()
        .ok_or(Error::Invalid("operation required"))?;
    for key in ["op", "id", "project_ref", "attachments"] {
        fields.remove(key);
    }
    if op == "epic.delete" {
        fields.remove("title");
    }
    let new_tags = normalize_tags(tx, ctx, project, &mut fields)?;
    let value = write(tx, ctx, resource, id, json!(fields))?;
    let mut result = json!({"op":op,"id":value["id"]});
    if op == "epic.delete" {
        result["title"] = value["title"].clone();
    } else if op.starts_with("epic.") {
        result["epic_ref"] = json!(format!("canon:epic/{}", text(&value, "id")?));
        result["title"] = value["title"].clone();
        result["plan"] = match value["plan_id"].as_str() {
            Some(id) => read(tx, Resource::Plan, id)?["title"].clone(),
            None => json!("Backlog"),
        };
        result["new_tags"] = json!(new_tags);
        result["attachments"] =
            json!(super::super::attachment_references(text(&value, "description")?)?.len());
    }
    Ok(result)
}
fn normalize_tags(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    fields: &mut serde_json::Map<String, Value>,
) -> Result<Vec<Value>> {
    let Some(tags) = fields.get("tags") else {
        return Ok(Vec::new());
    };
    let mut ids = Vec::new();
    let mut added = Vec::new();
    for tag in tags
        .as_array()
        .ok_or(Error::Invalid("tags must be an array"))?
    {
        if let Some(id) = tag["tag_id"].as_str() {
            ids.push(json!(id));
        } else if tag["new"].is_object() {
            let created = write(tx, ctx, Resource::CreateTag, project, tag["new"].clone())?;
            added.push(created.clone());
            ids.push(created["id"].clone());
        } else {
            return Err(Error::Invalid("tag_id or new required"));
        }
    }
    fields.insert("tags".into(), json!(ids));
    Ok(added)
}
