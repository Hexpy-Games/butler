use super::*;
use rusqlite::params;

pub(in crate::store) fn append(
    tx: &Transaction<'_>,
    ctx: &Context,
    kind: &str,
    id: &str,
    revision: i64,
    op: &str,
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
    if matches!(kind, "task" | "task_graph") || (kind == "work" && op == "state") {
        let work_id = if kind == "task" {
            text(&read_task(tx, id)?, "work_id")?.to_owned()
        } else {
            id.to_owned()
        };
        tasks_changed(tx, ctx, &work_id)?;
    }
    Ok(())
}

fn tasks_changed(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    let row = read_work(tx, id)?;
    let session = row["home_session_id"].as_str().or_else(|| {
        (row["scope_kind"] == "session")
            .then(|| row["scope_ref"].as_str())
            .flatten()
    });
    let payload = json!({"scope":"tasks","work_id":id,"session_id":session,
        "task_graph_revision":row["task_graph_revision"]})
    .to_string();
    let seq: Option<i64> = tx
        .query_row(
            "SELECT seq FROM wm_outbox WHERE seq>?1 AND topic='work_model.changed'
         AND json_extract(payload_json,'$.work_id')=?2 LIMIT 1",
            params![tx.outbox_start, id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(seq) = seq {
        tx.execute(
            "UPDATE wm_outbox SET payload_json=?1 WHERE seq=?2",
            params![payload, seq],
        )?;
    } else {
        tx.execute(
            super::super::sql::OUTBOX,
            params!["work_model.changed", payload, ctx.now],
        )?;
    }
    Ok(())
}
