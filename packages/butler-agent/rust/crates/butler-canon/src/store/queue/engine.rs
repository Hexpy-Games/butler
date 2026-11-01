use super::*;

/// The step's Turn ended with nothing closed; a reply can still finish it.
const UNFINISHED: &str = "step_unfinished";
/// The step's Work closed as blocked, or as completed against its own record.
const BLOCKED: &str = "work_blocked";

/// Called only for sessions named by changed epics or an explicit queue act.
pub fn ready(tx: &Transaction<'_>, ctx: &Context, session: &str) -> Result<()> {
    ready_inner(tx, ctx, session, true)
}

/// Run after saving membership, before the edit advances and publishes its revision.
pub(super) fn after_edit(tx: &Transaction<'_>, ctx: &Context, session: &str) -> Result<()> {
    ready_inner(tx, ctx, session, false)
}

fn ready_inner(tx: &Transaction<'_>, ctx: &Context, session: &str, advance: bool) -> Result<()> {
    let items = items(tx, session)?;
    let mut started = false;
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
                revision(tx, session)? + i64::from(!advance)
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
            started = true;
        }
    }
    if advance && started {
        changed(tx, ctx, session)?;
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
        // Asking and waiting can look either way: both clear when the reply finishes the Work.
        let unfinished = matches!(item["hold_reason"].as_str(), Some(UNFINISHED | BLOCKED))
            && item["decision"].is_null();
        if item["state"] == "running" && (item["hold_reason"].is_null() || unfinished) {
            let started = item["started_at"]
                .as_i64()
                .ok_or(Error::Invalid("started_at"))?;
            if let Some(work) = runtime::queue_outcome(tx, epic, session, started, views)? {
                let id = text(&work, "work_id")?;
                if work["reported"] == true && unfinished {
                    resolve(tx, ctx, &item, id)?;
                } else if unfinished {
                    // Its card already stands; a blocked reply needs no second one.
                } else if work["failed"] == true {
                    fail(tx, ctx, &item, BLOCKED)?;
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
/// The reply to a step that stopped closed its Work: the run goes on.
fn resolve(tx: &Transaction<'_>, ctx: &Context, item: &Value, work: &str) -> Result<()> {
    let session = text(item, "session_id")?;
    let epic = text(item, "epic_id")?;
    tx.execute(sql::RESOLVE, params![session, epic, work, ctx.now])?;
    tx.execute(sql::UNHOLD, params![session, epic])?;
    let op = text(item, "question_message_id")?;
    record_intent(
        tx,
        ctx,
        &format!("{op}:resolved"),
        "canon_hold",
        &json!({"session_id":session,"epic_id":epic,"epic_title":read_work(tx,epic)?["title"],"source_key":op,"state":"resolved"}),
    )?;
    changed(tx, ctx, session)?;
    Ok(())
}
pub fn turn_ended(
    tx: &Transaction<'_>,
    ctx: &Context,
    op: &str,
    outcome: &str,
    turn: Option<&str>,
) -> Result<Value> {
    let mut changed_epics = BTreeSet::new();
    if let Some(epic) = tx
        .query_row(
            "SELECT epic_id FROM canon_step_cancellations WHERE op_id=?1",
            [op],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        tx.execute("DELETE FROM canon_step_cancellations WHERE op_id=?1", [op])?;
        changed_epics.insert(epic.clone());
        for owner in rows(tx, sql::OWNER, [&epic])? {
            ready(tx, ctx, text(&owner, "session_id")?)?;
        }
    }
    if matches!(
        outcome,
        "delivered" | "cancelled" | "failed" | "turn_interrupted"
    ) {
        for row in rows(
            tx,
            "UPDATE canon_session_queue SET turn_ended_at=COALESCE(turn_ended_at,?2),step_turn_id=COALESCE(step_turn_id,?3) WHERE step_op_id=?1 AND (turn_ended_at IS NULL OR (step_turn_id IS NULL AND ?3 IS NOT NULL)) RETURNING epic_id",
            params![op, ctx.now, turn],
        )? {
            changed_epics.insert(text(&row, "epic_id")?.to_owned());
        }
    }
    let item = rows(tx, sql::STEP, [op])?.into_iter().next();
    if let Some(item) = item
        && item["state"] == "running"
        && item["hold_reason"].is_null()
    {
        if matches!(outcome, "cancelled" | "failed" | "turn_interrupted") {
            fail(tx, ctx, &item, outcome)?;
        } else if outcome == "delivered"
            && runtime::step_unfinished(
                tx,
                text(&item, "epic_id")?,
                text(&item, "session_id")?,
                item["started_at"]
                    .as_i64()
                    .ok_or(Error::Invalid("started_at"))?,
                turn,
            )?
        {
            fail(tx, ctx, &item, UNFINISHED)?;
        }
    }
    for epic in changed_epics {
        runtime::progress_event(tx, ctx, &epic)?;
    }
    Ok(json!({"ok":true}))
}
/// The conversation's work was stopped from outside, so nothing can finish these steps.
pub fn stop_running(tx: &Transaction<'_>, ctx: &Context, session: &str) -> Result<Value> {
    for item in items(tx, session)? {
        if item["state"] == "running" && item["hold_reason"].is_null() {
            fail(tx, ctx, &item, "cancelled")?;
        }
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
        &json!({"session_id":session,"epic_id":epic,"epic_title":read_work(tx,epic)?["title"],"hold_reason":reason,"state":"pending"}),
    )?;
    changed(tx, ctx, session)?;
    Ok(())
}
