use super::*;
use crate::work_chain::Placement;

pub fn edit(tx: &Transaction<'_>, ctx: &Context, session: &str, input: &Value) -> Result<Value> {
    let expected = input["expected_graph_revision"]
        .as_i64()
        .ok_or(Error::Invalid("expected_graph_revision"))?;
    let rev = revision(tx, session)?;
    if expected != rev {
        return Err(Error::Conflict {
            current: json!({"graph_revision":rev}),
        });
    }
    let items = items(tx, session)?;
    let mut chains = chains(&items)?;
    let id = EpicId(text(input, "epic_id")?.to_owned());
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
        "move_to_new_step" => chain.move_to_new_step(&id, index(input, "index")?, &running)?,
        "join_stack" => chain.join_stack(&id, &target()?, &running)?,
        "split_stack" => chain.split_stack(index(item, "step_index")?, &running)?,
        "delete" => {
            let next = chain.delete(&id, &running)?;
            tx.execute(sql::REMOVE, params![session, id.as_str()])?;
            next
        }
        "start_now" => {
            let next = chain.detach(&id, &running)?;
            let head = format!("head:{session}:{}", rev + 1);
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
            let (next, other) = chain.move_between(other, &id, placement, &running)?;
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
    changed(tx, ctx, session)?;
    engine::ready(tx, ctx, session)?;
    view(tx, session, &runtime::ProjectViews::new())
}
