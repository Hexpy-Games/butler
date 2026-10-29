//! App-only human decisions and indexed, batched active-tree projections.
use super::*;
use rusqlite::{params, params_from_iter};
use std::collections::HashMap;

/// Replaced with a bounded placeholder list, never an interpolated input value.
pub const COUNTS: &str = "SELECT e.id,c.criterion_id,ch.node_id IS NOT NULL AS confirmed
 FROM canon_epics e JOIN canon_spec_nodes n ON n.node_id=e.spec_node_id
 JOIN canon_spec_criteria c ON c.node_id=n.node_id
 AND c.revision=n.active_revision
 LEFT JOIN canon_criterion_checks ch ON ch.node_id=c.node_id AND ch.criterion_id=c.criterion_id AND ch.text=c.text
 WHERE e.id IN (?1)";

pub fn enrich(db: &Connection, epics: &mut [Value]) -> Result<()> {
    for batch in epics.chunks_mut(400) {
        let ids = batch
            .iter()
            .map(|e| text(e, "id"))
            .collect::<Result<Vec<_>>>()?;
        let placeholders = (1..=ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let mut counts = HashMap::<String, (u64, u64)>::new();
        for row in rows(
            db,
            &COUNTS.replace("?1", &placeholders),
            params_from_iter(ids),
        )? {
            let count = counts.entry(text(&row, "id")?.into()).or_default();
            count.0 += u64::from(row["confirmed"] == 1);
            count.1 += 1;
        }
        for epic in batch {
            epic["criteria"] = counts.get(text(epic, "id")?).map_or(
                Value::Null,
                |(confirmed, total)| json!({"confirmed":confirmed,"total":total}),
            );
        }
    }
    Ok(())
}

pub fn latest(db: &Connection, node: &str) -> Result<Option<i64>> {
    Ok(db.query_row(
        "SELECT MAX(revision) FROM canon_spec_revisions WHERE node_id=?1",
        [node],
        |r| r.get(0),
    )?)
}

pub fn for_revision(db: &Connection, node: &str, revision: Option<i64>) -> Result<Vec<Value>> {
    let mut criteria = rows(
        db,
        "SELECT c.*,ch.node_id IS NOT NULL AS confirmed
        FROM canon_spec_criteria c LEFT JOIN canon_criterion_checks ch
        ON ch.node_id=c.node_id AND ch.criterion_id=c.criterion_id AND ch.text=c.text
        WHERE c.node_id=?1 AND c.revision=?2 ORDER BY c.part_id,c.criterion_id",
        params![node, revision],
    )?;
    for criterion in &mut criteria {
        criterion["confirmed"] = json!(criterion["confirmed"] == 1);
    }
    Ok(criteria)
}

pub fn toggle(tx: &Transaction<'_>, ctx: &Context, node_id: &str, input: Value) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        criterion_id: String,
        confirmed: bool,
        expected_revision: i64,
    }
    if ctx.actor["via"] != "app"
        || ctx.actor["origin"] == "mcp"
        || ctx.actor["person"].as_str().is_none_or(str::is_empty)
    {
        return Err(Error::Permission);
    }
    let input: Input =
        serde_json::from_value(input).map_err(|_| Error::Invalid("invalid request fields"))?;
    let node = one(tx, sql::NODE, [node_id])?;
    if node["scope_kind"] != "project" || node["visibility"] != "canon" {
        return Err(Error::NotFound);
    }
    cas(&node, "revision", input.expected_revision)?;
    let revision = node["active_revision"].as_i64().ok_or(Error::NotFound)?;
    let criterion = one(
        tx,
        "SELECT * FROM canon_spec_criteria WHERE node_id=?1 AND revision=?2 AND criterion_id=?3",
        params![node_id, revision, input.criterion_id],
    )?;
    let was_confirmed = tx.query_row("SELECT EXISTS(SELECT 1 FROM canon_criterion_checks WHERE node_id=?1 AND criterion_id=?2 AND text=?3)",
        params![node_id,input.criterion_id,text(&criterion,"text")?], |r| r.get::<_,bool>(0))?;
    if was_confirmed != input.confirmed {
        if input.confirmed {
            tx.execute("INSERT INTO canon_criterion_checks(node_id,criterion_id,revision,text,confirmed_by,at) VALUES(?1,?2,?3,?4,?5,?6)
                ON CONFLICT(node_id,criterion_id) DO UPDATE SET revision=excluded.revision,text=excluded.text,confirmed_by=excluded.confirmed_by,at=excluded.at",
                params![node_id,input.criterion_id,revision,text(&criterion,"text")?,ctx.actor.to_string(),ctx.now])?;
        } else {
            tx.execute(
                "DELETE FROM canon_criterion_checks WHERE node_id=?1 AND criterion_id=?2",
                params![node_id, input.criterion_id],
            )?;
        }
        activity::append(
            tx,
            ctx,
            node_id,
            if input.confirmed {
                "criterion_confirmed"
            } else {
                "criterion_unconfirmed"
            },
            &input.criterion_id,
            None,
        )?;
        api::outbox(
            tx,
            ctx,
            "spec_node",
            node_id,
            input.expected_revision,
            &json!({}),
        )?;
    }
    Ok(json!({"node_id":node_id,"criterion_id":input.criterion_id,"confirmed":input.confirmed}))
}

/// Drop changed or removed decisions when a publication becomes active.
pub(super) fn reconcile(tx: &Transaction<'_>, node: &str, revision: i64) -> Result<()> {
    tx.execute("DELETE FROM canon_criterion_checks WHERE node_id=?1 AND NOT EXISTS (
        SELECT 1 FROM canon_spec_criteria c WHERE c.node_id=?1 AND c.revision=?2
        AND c.criterion_id=canon_criterion_checks.criterion_id AND c.text=canon_criterion_checks.text)", params![node,revision])?;
    Ok(())
}
