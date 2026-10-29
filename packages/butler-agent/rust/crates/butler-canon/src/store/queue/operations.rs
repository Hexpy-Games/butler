use super::*;

pub fn request(tx: &Transaction<'_>, ctx: &Context, session: &str, input: &Value) -> Result<Value> {
    let op = text(input, "op")?;
    if op == "remove" {
        return remove_request(tx, ctx, session, input);
    }
    let epics = if op == "plan_run" {
        let plan = text(input, "plan_id")?;
        read_plan(tx, plan)?;
        rows(tx, sql::PLAN_EPICS, [plan])?
            .into_iter()
            .map(|e| text(&e, "id").map(str::to_owned))
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![text(input, "epic_id")?.to_owned()]
    };
    for epic in &epics {
        read_work(tx, epic)?;
        if let Some(other) = elsewhere(tx, session, epic)? {
            return held_elsewhere(tx, ctx, session, &other);
        }
    }
    let head = format!("head:{session}:{}", revision(tx, session)? + 1);
    let existing = items(tx, session)?;
    if epics.iter().any(|id| {
        existing
            .iter()
            .any(|i| i["epic_id"] == *id && i["state"] == "running")
    }) {
        return Err(Error::Invalid("running epics are pinned"));
    }
    for (index, epic) in epics.iter().enumerate() {
        if existing.iter().any(|i| i["epic_id"] == *epic) {
            remove(tx, session, epic, true)?;
        }
        insert(
            tx,
            ctx,
            session,
            epic,
            &head,
            index,
            (
                if op == "start_now" {
                    "detach"
                } else {
                    "user_message"
                },
                input["origin_message_id"].as_str(),
            ),
        )?;
    }
    if matches!(op, "after" | "together") {
        let epic = epics.first().ok_or(Error::Invalid("epic"))?;
        attach(
            tx,
            session,
            epic,
            text(input, "target_epic_id")?,
            op == "together",
        )?;
    } else if !matches!(op, "plan_run" | "start_now") {
        return Err(Error::Invalid("queue operation"));
    }
    changed(tx, ctx, session)?;
    engine::ready(tx, ctx, session)?;
    view(tx, session, &runtime::ProjectViews::new())
}
fn remove_request(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    input: &Value,
) -> Result<Value> {
    let epic = text(input, "epic_id")?;
    let item = rows(tx, sql::ITEM, params![session, epic])?;
    if item.first().is_none_or(|i| i["state"] == "removed") {
        return Ok(
            json!({"ok":false,"error":{"code":"not_queued_here","message":"This epic is not queued in this conversation. Read this conversation's queue and select an item from it."}}),
        );
    }
    let mut input = input.clone();
    input["op"] = json!("delete");
    input["expected_graph_revision"] = json!(revision(tx, session)?);
    edit(tx, ctx, session, &input)
}

fn attach(
    tx: &Transaction<'_>,
    session: &str,
    epic: &str,
    target: &str,
    together: bool,
) -> Result<()> {
    let items = items(tx, session)?;
    let item = items
        .iter()
        .find(|i| i["epic_id"] == target)
        .ok_or(Error::NotFound)?;
    let chain_id = text(item, "chain_id")?;
    let chains = chains(&items)?;
    let chain = chains.get(chain_id).ok_or(Error::NotFound)?;
    let running = items
        .iter()
        .filter(|i| i["state"] == "running")
        .map(|i| text(i, "epic_id").map(|s| EpicId(s.to_owned())))
        .collect::<Result<BTreeSet<_>>>()?;
    let chain = chain.place_after(
        EpicId(epic.to_owned()),
        &EpicId(target.to_owned()),
        &running,
    )?;
    let chain = if together {
        chain.join_stack(
            &EpicId(epic.to_owned()),
            &EpicId(target.to_owned()),
            &running,
        )?
    } else {
        chain
    };
    save(tx, session, chain_id, &chain)
}
fn remove(tx: &Transaction<'_>, session: &str, epic: &str, pin_running: bool) -> Result<()> {
    let items = items(tx, session)?;
    let item = items
        .iter()
        .find(|i| i["epic_id"] == epic)
        .ok_or(Error::NotFound)?;
    let id = text(item, "chain_id")?;
    let chain = chains(&items)?.remove(id).ok_or(Error::NotFound)?;
    let running = items
        .iter()
        .filter(|i| pin_running && i["state"] == "running")
        .map(|i| text(i, "epic_id").map(|s| EpicId(s.to_owned())))
        .collect::<Result<BTreeSet<_>>>()?;
    let next = chain.delete(&EpicId(epic.to_owned()), &running)?;
    tx.execute(sql::DELETE_ITEM, params![session, epic])?;
    save(tx, session, id, &next)
}
pub fn decide_hold(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    epic: &str,
    decision: &str,
) -> Result<Value> {
    if !matches!(decision, "delete" | "continue") {
        return Err(Error::Invalid("hold decision"));
    }
    let item = one(tx, sql::ITEM, params![session, epic])?;
    if item["hold_reason"].is_null()
        || !item["decision"].is_null()
        || item["question_message_id"].is_null()
    {
        return Err(Error::Conflict {
            current: json!({"graph_revision":revision(tx,session)?}),
        });
    }
    if decision == "delete" {
        let chain_id = text(&item, "chain_id")?;
        let chain = chains(&items(tx, session)?)?
            .remove(chain_id)
            .ok_or(Error::NotFound)?;
        let next = chain.delete(&EpicId(epic.to_owned()), &BTreeSet::new())?;
        save(tx, session, chain_id, &next)?;
    }
    tx.execute(
        sql::DECIDE,
        params![
            session,
            epic,
            if decision == "delete" {
                "removed"
            } else {
                "done"
            },
            decision,
            ctx.now
        ],
    )?;
    tx.execute(sql::UNHOLD, params![session, epic])?;
    let op = text(&item, "question_message_id")?;
    record_intent(
        tx,
        ctx,
        &format!("{op}:{decision}"),
        "canon_hold",
        &json!({"session_id":session,"epic_id":epic,"epic_title":read_work(tx,epic)?["title"],"source_key":op,"state":if decision=="delete" {"deleted"} else {"continued"}}),
    )?;
    changed(tx, ctx, session)?;
    engine::ready(tx, ctx, session)?;
    view(tx, session, &runtime::ProjectViews::new())
}
pub fn take_here(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    epic: &str,
    expected_owner: &str,
    expected_op: Option<&str>,
) -> Result<Value> {
    let other = elsewhere(tx, session, epic)?.ok_or(Error::Conflict {
        current: json!({"graph_revision":revision(tx,session)?}),
    })?;
    let owner = text(&other, "session_id")?;
    if owner != expected_owner || other["step_op_id"].as_str() != expected_op {
        return Err(Error::Conflict {
            current: json!({"graph_revision":revision(tx,session)?}),
        });
    }
    if let Some(op) = expected_op {
        tx.execute("INSERT INTO canon_step_cancellations(op_id,epic_id,source_session_id) VALUES(?1,?2,?3)", params![op, epic, owner])?;
        tx.execute("UPDATE canon_intents SET state='applied',revision=revision+1 WHERE op_id=?1 AND state='pending'",[op])?;
    }
    if let Some(source) = other["question_message_id"].as_str() {
        record_intent(
            tx,
            ctx,
            &format!("{source}:taken"),
            "canon_hold",
            &json!({"session_id":owner,"epic_id":epic,"epic_title":other["title"],"source_key":source,"state":"deleted"}),
        )?;
    }
    remove(tx, owner, epic, false)?;
    tx.execute(sql::UNHOLD, params![owner, epic])?;
    changed(tx, ctx, owner)?;
    engine::ready(tx, ctx, owner)?;
    let head = format!("head:{session}:{}", revision(tx, session)? + 1);
    insert(tx, ctx, session, epic, &head, 0, ("detach", None))?;
    changed(tx, ctx, session)?;
    engine::ready(tx, ctx, session)?;
    taken(tx, ctx, session, epic)?;
    view(tx, session, &runtime::ProjectViews::new())
}
pub fn bound_sessions(db: &Connection) -> Result<Value> {
    Ok(json!(
        rows(db, sql::BOUND_SESSIONS, [])?
            .into_iter()
            .map(|r| r["session_id"].clone())
            .collect::<Vec<_>>()
    ))
}
pub fn session_deleted(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    op: &str,
) -> Result<Value> {
    let intent = with_intent(
        tx,
        ctx,
        op,
        "session_delete",
        &json!({"session_id":session}),
        |tx| {
            tx.execute(sql::DELETE_QUEUE, [session])?;
            tx.execute(
                "DELETE FROM canon_session_queue_chains WHERE session_id=?1",
                [session],
            )?;
            tx.execute(sql::DELETE_BINDINGS, [session])?;
            changed(tx, ctx, session)?;
            tx.execute(sql::CANCEL_INTENTS, [session])?;
            tx.execute(sql::CANCEL_OTHER_INTENTS, [session])?;
            // A deleted source has no turn left to stop. Keep the committed move
            // and use the normal terminal receipt to unblock its current owner.
            for cancellation in rows(tx, sql::SOURCE_CANCELLATIONS, [session])? {
                engine::turn_ended(tx, ctx, text(&cancellation, "op_id")?, "cancelled")?;
            }
            tx.execute(sql::DELETE_HEAD, [session])?;
            Ok(())
        },
    )?;
    super::super::api::canon_conversation::applied(
        tx,
        ctx,
        op,
        intent["revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?,
    )
}

pub fn owner(db: &Connection, epic: &str) -> Result<Value> {
    Ok(rows(db, sql::OWNER, [epic])?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

fn taken(tx: &Transaction<'_>, ctx: &Context, session: &str, epic: &str) -> Result<()> {
    let offers = rows(tx, sql::OFFERS, params![session, epic])?;
    for offer in offers {
        let source = text(&offer, "op_id")?;
        let mut panel: Value = serde_json::from_str(text(&offer, "payload_json")?)?;
        panel["source_key"] = json!(source);
        panel["state"] = json!("taken");
        record_intent(
            tx,
            ctx,
            &format!("{source}:taken"),
            "canon_take_here",
            &panel,
        )?;
    }
    Ok(())
}
