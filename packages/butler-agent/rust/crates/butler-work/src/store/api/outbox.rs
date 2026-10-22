use super::*;
use rusqlite::params;

pub(in crate::store) fn append(
    tx: &Transaction<'_>,
    ctx: &Context,
    kind: &str,
    id: &str,
    revision: i64,
) -> Result<()> {
    let project = match kind {
        "plan" => {
            let row = read_plan(tx, id)?;
            (row["visibility"] == "canon").then(|| row["project_id"].clone())
        }
        "backlog" => Some(json!(id)),
        "work" => {
            let row = read_work(tx, id)?;
            (row["visibility"] == "canon" && row["scope_kind"] == "project")
                .then(|| row["scope_ref"].clone())
        }
        "spec_node" => {
            let row = one(tx, super::super::sql::NODE, [id])?;
            (row["visibility"] == "canon" && row["scope_kind"] == "project")
                .then(|| row["scope_ref"].clone())
        }
        _ => None,
    };
    if let Some(project) = project {
        let origin = if ctx.actor.get("person").is_some() && ctx.actor["via"] != "butler" {
            "local"
        } else {
            "butler"
        };
        let payload =
            json!({"project_id":project,"kind":kind,"id":id,"revision":revision,"origin":origin});
        tx.execute(
            super::super::sql::OUTBOX,
            params!["canon.changed", payload.to_string(), ctx.now],
        )?;
    }
    if kind == "task_graph" {
        let row = read_work(tx, id)?;
        let session = row["home_session_id"].as_str().or_else(|| {
            (row["scope_kind"] == "session")
                .then(|| row["scope_ref"].as_str())
                .flatten()
        });
        let payload = json!({"scope":"tasks","work_id":id,"session_id":session,"task_graph_revision":revision});
        tx.execute(
            super::super::sql::OUTBOX,
            params!["work_model.changed", payload.to_string(), ctx.now],
        )?;
    }
    Ok(())
}
