use super::*;

/// Called only for sessions named by changed epics or an explicit queue act.
pub fn ready(tx: &Transaction<'_>, ctx: &Context, session: &str) -> Result<()> {
    let items = items(tx, session)?;
    for (chain_id, chain) in chains(&items)? {
        let chain_items = items
            .iter()
            .filter(|i| i["chain_id"] == chain_id)
            .collect::<Vec<_>>();
        if let Some(failed) = chain_items
            .iter()
            .find(|i| i["state"] == "running" && !i["hold_reason"].is_null())
        {
            tx.execute(
                sql::HOLD_SUCCESSORS,
                params![
                    session,
                    chain_id,
                    text(failed, "epic_id")?,
                    failed["step_index"].as_i64()
                ],
            )?;
            continue;
        }
        if chain_items.iter().any(|i| i["state"] == "held") {
            continue;
        }
        let Some(step) = chain.steps.iter().find(|s| {
            s.tasks.iter().any(|id| {
                chain_items
                    .iter()
                    .any(|i| i["epic_id"] == id.as_str() && i["state"] != "done")
            })
        }) else {
            continue;
        };
        for epic in &step.tasks {
            let item = chain_items
                .iter()
                .find(|i| i["epic_id"] == epic.as_str())
                .ok_or(Error::NotFound)?;
            let cancelling = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM canon_step_cancellations WHERE epic_id=?1)",
                [epic.as_str()],
                |r| r.get::<_, bool>(0),
            )?;
            if item["state"] != "waiting" || cancelling {
                continue;
            }
            let op = format!(
                "canon-step:{session}:{}:{}",
                epic.as_str(),
                revision(tx, session)?
            );
            let plan = item["plan_id"]
                .as_str()
                .map(|id| read_plan(tx, id))
                .transpose()?;
            record_intent(
                tx,
                ctx,
                &op,
                "canon_step",
                &json!({"session_id":session,"epic_id":epic,"plan_id":item["plan_id"],"untrusted_content":{"epic_title":item["title"],"plan_title":plan.map(|p|p["title"].clone()).unwrap_or(json!(""))}}),
            )?;
            tx.execute(sql::START, params![session, epic.as_str(), ctx.now, op])?;
            changed(tx, ctx, session)?;
        }
    }
    Ok(())
}
pub fn reconcile(
    tx: &Transaction<'_>,
    ctx: &Context,
    epic: &str,
    views: &runtime::ProjectViews,
) -> Result<()> {
    let active = rows(tx, sql::OWNER, [epic])?;
    for item in active {
        let session = text(&item, "session_id")?;
        if item["state"] == "running" && item["hold_reason"].is_null() {
            let started = item["started_at"]
                .as_i64()
                .ok_or(Error::Invalid("started_at"))?;
            if let Some(work) = runtime::queue_outcome(tx, epic, session, started, views)? {
                let id = text(&work, "work_id")?;
                if work["failed"] == true {
                    fail(tx, ctx, &item, "work_blocked")?;
                } else if work["reported"] == true {
                    tx.execute(sql::DONE, params![session, epic, id, ctx.now])?;
                    changed(tx, ctx, session)?;
                }
            }
        }
        ready(tx, ctx, session)?;
    }
    Ok(())
}
pub fn turn_ended(tx: &Transaction<'_>, ctx: &Context, op: &str, outcome: &str) -> Result<Value> {
    if let Some(epic) = tx
        .query_row(
            "SELECT epic_id FROM canon_step_cancellations WHERE op_id=?1",
            [op],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        tx.execute("DELETE FROM canon_step_cancellations WHERE op_id=?1", [op])?;
        for owner in rows(tx, sql::OWNER, [&epic])? {
            ready(tx, ctx, text(&owner, "session_id")?)?;
        }
    }
    let item = rows(tx, sql::STEP, [op])?.into_iter().next();
    if let Some(item) = item
        && item["state"] == "running"
        && item["hold_reason"].is_null()
        && matches!(outcome, "cancelled" | "failed" | "turn_interrupted")
    {
        fail(tx, ctx, &item, outcome)?;
    }
    Ok(json!({"ok":true}))
}
fn fail(tx: &Transaction<'_>, ctx: &Context, item: &Value, reason: &str) -> Result<()> {
    let session = text(item, "session_id")?;
    let epic = text(item, "epic_id")?;
    let op = format!("canon-hold:{}", text(item, "step_op_id")?);
    tx.execute(sql::FAIL, params![session, epic, reason, op])?;
    tx.execute(
        sql::HOLD_SUCCESSORS,
        params![
            session,
            text(item, "chain_id")?,
            epic,
            item["step_index"].as_i64()
        ],
    )?;
    record_intent(
        tx,
        ctx,
        &op,
        "canon_hold",
        &json!({"session_id":session,"epic_id":epic,"epic_title":read_work(tx,epic)?["title"],"state":"pending"}),
    )?;
    changed(tx, ctx, session)?;
    Ok(())
}
