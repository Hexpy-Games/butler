use super::*;
use rusqlite::params;

pub(in crate::store) fn append(
    tx: &Transaction<'_>,
    ctx: &Context,
    kind: &str,
    id: &str,
    revision: i64,
    details: &Value,
) -> Result<()> {
    let project = match kind {
        "plan" => {
            let row = read_plan(tx, id)?;
            Some(row["project_id"].clone())
        }
        "tag" => Some(one(tx, sql::TAG, [id])?["project_id"].clone()),
        "backlog" => Some(json!(id)),
        "work" => {
            let row = read_work(tx, id)?;
            Some(row["project_id"].clone())
        }
        "spec_node" => {
            let row = one(tx, super::super::sql::NODE, [id])?;
            (row["visibility"] == "canon" && row["scope_kind"] == "project")
                .then(|| row["scope_ref"].clone())
        }
        _ => None,
    };
    if let Some(project) = project {
        let origin = if ctx.actor["origin"] == "mcp" {
            "mcp"
        } else if ctx.actor.get("person").is_some() && ctx.actor["via"] != "butler" {
            "local"
        } else {
            "butler"
        };
        let mut payload =
            json!({"project_id":project,"kind":kind,"id":id,"revision":revision,"origin":origin});
        if let (Some(payload), Some(details)) = (payload.as_object_mut(), details.as_object()) {
            payload.extend(details.clone());
        }
        if kind == "work" && details["deleted"] != true {
            let row = read_work(tx, id)?;
            payload["attachments"] = json!(crate::store::attachments::references_lenient(
                row["description"].as_str().unwrap_or_default(),
            ));
        }
        if details["deleted"] == true {
            payload["attachments"] = json!([]);
        }
        tx.execute(
            super::super::sql::OUTBOX,
            params!["canon.changed", payload.to_string(), ctx.now],
        )?;
    }
    Ok(())
}
