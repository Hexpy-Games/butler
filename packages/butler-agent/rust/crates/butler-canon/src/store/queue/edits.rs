use super::*;
use crate::work_chain::Placement;

pub fn edit(tx: &Transaction<'_>, ctx: &Context, session: &str, input: &Value) -> Result<Value> {
    check_revision(tx, session, &input["expected_graph_revision"], true)?;
    let rev = revision(tx, session)?;
    let items = items(tx, session)?;
    let mut chains = chains(&items)?;
    let (order, ids) = selected(input, &items)?;
    let id = ids
        .first()
        .ok_or(Error::Invalid("epic_ids must be nonempty"))?
        .clone();
    let item = items
        .iter()
        .find(|i| i["epic_id"] == id.as_str())
        .ok_or(Error::NotFound)?;
    let source = text(item, "chain_id")?;
    let chain = chains.get(source).ok_or(Error::NotFound)?.clone();
    let running = items
        .iter()
        .filter(|i| i["state"] == "running")
        .map(|i| text(i, "epic_id").map(|s| EpicId(s.to_owned())))
        .collect::<Result<BTreeSet<_>>>()?;
    let target = || text(input, "target_epic_id").map(|s| EpicId(s.to_owned()));
    let next = match text(input, "op")? {
        "move_to_new_step" => {
            chain.move_many(&ids, Placement::NewStep(index(input, "index")?), &running)?
        }
        "join_stack" => chain.move_many(&ids, Placement::Stack(target()?), &running)?,
        "split_stack" => chain.split_stack(index(item, "step_index")?, &running)?,
        "set_order" => reorder(&chain, order, &items, source, &running)?,
        "delete" => {
            let next = chain.delete(&id, &running)?;
            tx.execute(sql::REMOVE, params![session, id.as_str()])?;
            next
        }
        "start_now" => {
            let next = chain.detach(&id, &running)?;
            let head = format!("head:{session}:{}", rev + 1);
            tx.execute(sql::INSERT_CHAIN, params![session, head, id.as_str()])?;
            tx.execute(sql::DETACH, params![session, id.as_str(), head])?;
            next
        }
        "move_between" => {
            let destination = text(input, "target_chain_id")?;
            if destination == source {
                return Err(Error::Invalid("distinct chains required"));
            }
            let other = chains.get(destination).ok_or(Error::NotFound)?;
            let placement = if input["target_epic_id"].is_string() {
                Placement::Stack(target()?)
            } else {
                Placement::NewStep(index(input, "index")?)
            };
            let (next, other) = chain.move_many_between(other, &ids, placement, &running)?;
            save(tx, session, destination, &other)?;
            next
        }
        _ => return Err(Error::Invalid("queue edit")),
    };
    chains.insert(source.to_owned(), next);
    save(
        tx,
        session,
        source,
        chains.get(source).ok_or(Error::NotFound)?,
    )?;
    engine::after_edit(tx, ctx, session)?;
    changed(tx, ctx, session)?;
    view(tx, session, &runtime::ProjectViews::new())
}

/// The whole new order, when given, and the epics whose chain the edit changes.
type Order = Vec<Vec<EpicId>>;

fn selected(input: &Value, items: &[Value]) -> Result<(Option<Order>, Vec<EpicId>)> {
    if input["op"] != "set_order" {
        return Ok((None, selection(input, items)?));
    }
    let order = new_order(input)?;
    let ids = order.first().cloned().unwrap_or_default();
    Ok((Some(order), ids))
}

fn reorder(
    chain: &Chain,
    order: Option<Order>,
    items: &[Value],
    source: &str,
    running: &BTreeSet<EpicId>,
) -> Result<Chain> {
    let order = order.ok_or(Error::Invalid("steps"))?;
    let done = items
        .iter()
        .filter(|i| i["chain_id"] == source && i["state"] == "done")
        .map(|i| text(i, "epic_id").map(|s| EpicId(s.to_owned())))
        .collect::<Result<BTreeSet<_>>>()?;
    Ok(chain.with_order(order, &done, running)?)
}

/// The unfinished steps of one chain, in their new order.
fn new_order(input: &Value) -> Result<Order> {
    let steps = input["steps"]
        .as_array()
        .filter(|steps| !steps.is_empty())
        .ok_or(Error::Invalid("steps must be a nonempty array"))?;
    steps
        .iter()
        .map(|step| {
            step.as_array()
                .ok_or(Error::Invalid("each step must be an array of epic ids"))?
                .iter()
                .map(|id| {
                    id.as_str()
                        .filter(|id| !id.is_empty())
                        .map(|id| EpicId(id.to_owned()))
                        .ok_or(Error::Invalid("steps must contain epic ids"))
                })
                .collect()
        })
        .collect()
}

/// Validate the whole selection before changing any chain or persistent row.
fn selection(input: &Value, items: &[Value]) -> Result<Vec<EpicId>> {
    if input.get("epic_id").is_some() && input.get("epic_ids").is_some() {
        return Err(Error::Invalid("provide exactly one of epic_id or epic_ids"));
    }
    let Some(list) = input.get("epic_ids") else {
        return Ok(vec![EpicId(text(input, "epic_id")?.to_owned())]);
    };
    if !matches!(
        input["op"].as_str(),
        Some("move_to_new_step" | "join_stack" | "move_between")
    ) {
        return Err(Error::Invalid(
            "epic_ids is supported only for move operations",
        ));
    }
    let list = list
        .as_array()
        .filter(|ids| !ids.is_empty())
        .ok_or(Error::Invalid("epic_ids must be a nonempty array"))?;
    let mut seen = BTreeSet::new();
    let mut source = None;
    let mut result = Vec::with_capacity(list.len());
    for value in list {
        let id = value
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or(Error::Invalid("epic_ids must contain nonempty strings"))?;
        if !seen.insert(id) {
            return Err(Error::Invalid("epic_ids contains duplicate epics"));
        }
        let item = items
            .iter()
            .find(|i| i["epic_id"] == id)
            .ok_or(Error::Invalid(
                "every epic_ids member must be queued in this session",
            ))?;
        if item["state"] == "done"
            || matches!(item["canon_status"].as_str(), Some("done" | "cancelled"))
        {
            return Err(Error::Invalid(
                "epic_ids cannot move done or cancelled epics",
            ));
        }
        let chain = text(item, "chain_id")?;
        if source.is_some_and(|source| source != chain) {
            return Err(Error::Invalid(
                "epic_ids must belong to the same source chain",
            ));
        }
        source = Some(chain);
        result.push(EpicId(id.to_owned()));
    }
    Ok(result)
}

/// CAS shared by model operations and UI edits, inside the writer transaction.
pub(super) fn check_revision(
    db: &Connection,
    session: &str,
    value: &Value,
    required: bool,
) -> Result<()> {
    if value.is_null() && !required {
        return Ok(());
    }
    let expected = value.as_i64().ok_or(Error::QueueRevisionRequired)?;
    let current = revision(db, session)?;
    if expected != current {
        return Err(Error::Conflict {
            current: json!({"graph_revision":current,"expected_revision":expected}),
        });
    }
    Ok(())
}
