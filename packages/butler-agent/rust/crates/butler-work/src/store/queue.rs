use super::*;
use crate::{
    work_chain::{Chain, Placement, Step},
    work_types::*,
};
use rusqlite::params;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone)]
pub struct StoredChain {
    pub id: String,
    pub session_id: String,
    pub graph_revision: i64,
    pub chain: Chain,
    pub members: Vec<Value>,
}
pub fn load_chain(db: &Connection, id: &str) -> Result<StoredChain> {
    let row = one(db, sql::CHAIN, [id])?;
    let members = rows(db, sql::MEMBERS, [id])?;
    let mut steps: Vec<Step> = Vec::new();
    for member in &members {
        let index = usize::try_from(
            member["step_index"]
                .as_u64()
                .ok_or(Error::Invalid("invalid step"))?,
        )
        .map_err(|_| Error::Invalid("step exceeds address space"))?;
        if steps.last().is_none_or(|s| s.index != index) {
            steps.push(Step {
                index,
                works: vec![],
            });
        }
        let step = steps.last_mut().ok_or(Error::Invalid("missing step"))?;
        if member["stack_position"].as_u64() != Some(step.works.len() as u64) {
            return Err(Error::Invalid("noncontiguous stack"));
        }
        step.works.push(WorkId(text(member, "id")?.into()));
    }
    let chain = Chain { steps };
    chain.validate()?;
    Ok(StoredChain {
        id: id.into(),
        session_id: text(&row, "session_id")?.into(),
        graph_revision: row["graph_revision"]
            .as_i64()
            .ok_or(Error::Invalid("invalid graph revision"))?,
        chain,
        members,
    })
}
pub(super) fn running(chains: &[&StoredChain]) -> BTreeSet<WorkId> {
    chains
        .iter()
        .flat_map(|c| &c.members)
        .filter(|m| m["run_state"] == "running" || m["run_state"] == "in_review")
        .filter_map(|m| m["id"].as_str().map(|s| WorkId(s.into())))
        .collect()
}
pub(super) fn bump(tx: &Transaction<'_>, ctx: &Context, id: &str, expected: i64) -> Result<()> {
    let row = one(tx, sql::CHAIN, [id])?;
    cas(&row, "graph_revision", expected)?;
    tx.execute(sql::BUMP_CHAIN, params![id, expected])?;
    event(tx, ctx, "chain", id, expected + 1, "edit")
}
fn positions(chain: &Chain) -> BTreeMap<String, (usize, usize)> {
    chain
        .steps
        .iter()
        .flat_map(|s| {
            s.works
                .iter()
                .enumerate()
                .map(move |(i, w)| (w.0.clone(), (s.index, i)))
        })
        .collect()
}
/// Remove all affected edges before changing composite-FK membership. Rebuild
/// exclusively from the pure Chain model after all membership changes.
pub(super) fn persist(
    tx: &Transaction<'_>,
    ctx: &Context,
    changes: &[(&StoredChain, &Chain)],
) -> Result<()> {
    for (old, next) in changes {
        next.validate()?;
        tx.execute(sql::DELETE_EDGES, [&old.id])?;
    }
    let mut destinations = BTreeMap::new();
    for (old, next) in changes {
        for (id, (step, stack)) in positions(next) {
            destinations.insert(id, (old.id.as_str(), step, stack));
        }
    }
    let ids: BTreeSet<_> = changes
        .iter()
        .flat_map(|(c, _)| c.members.iter().filter_map(|m| m["id"].as_str()))
        .chain(destinations.keys().map(String::as_str))
        .collect();
    for id in ids {
        let row = read_work(tx, id)?;
        let destination = destinations.get(id);
        let (chain, step, stack) = match destination {
            Some((c, s, p)) => (Some(*c), Some(*s), Some(*p)),
            None => (None, None, None),
        };
        if row["chain_id"] != json!(chain)
            || row["step_index"] != json!(step)
            || row["stack_position"] != json!(stack)
        {
            tx.execute(
                sql::MEMBERSHIP,
                params![id, chain, step, stack, ctx.now, row["revision"].as_i64()],
            )?;
            event(
                tx,
                ctx,
                "work",
                id,
                row["revision"].as_i64().ok_or(Error::Invalid("revision"))? + 1,
                "membership",
            )?;
        }
    }
    for (old, next) in changes {
        rederive_holds(tx, ctx, &old.id)?;
        for (pred, succ) in next.edges()? {
            tx.execute(sql::INSERT_EDGE, params![pred.0, succ.0, old.id])?;
        }
        bump(tx, ctx, &old.id, old.graph_revision)?;
    }
    Ok(())
}
pub(super) fn update_chain_state(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let members = rows(tx, sql::MEMBERS, [id])?;
    let state = if !undecided_holds(tx, id)?.is_empty() {
        "held"
    } else if members
        .iter()
        .all(|r| r["run_state"] == "done" && !r["result_reported_at"].is_null())
    {
        "done"
    } else {
        "active"
    };
    tx.execute(sql::CHAIN_STATE, params![id, state])?;
    Ok(())
}
#[allow(
    clippy::too_many_arguments,
    reason = "explicit queue provenance and CAS"
)]
pub fn create_root(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    chain_id: &str,
    session: &str,
    origin: QueueOrigin,
    message: Option<&str>,
) -> Result<Value> {
    let row = read_work(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    if row["run_state"] != "idle" || !row["chain_id"].is_null() {
        return Err(Error::Invalid("Work must be idle and unqueued"));
    }
    check_chat(&row, session)?;
    tx.execute(sql::INSERT_CHAIN, params![chain_id, session, ctx.now])?;
    let old = load_chain(tx, chain_id)?;
    let next = Chain {
        steps: vec![Step {
            index: 0,
            works: vec![WorkId(id.into())],
        }],
    };
    persist(tx, ctx, &[(&old, &next)])?;
    tx.execute(sql::PROVENANCE, params![id, origin.as_str(), message])?;
    work_result(tx, id, None)
}
pub(super) fn check_chat(row: &Value, session: &str) -> Result<()> {
    if row["scope_kind"] == "session" && row["scope_ref"] != session {
        return Err(Error::CrossChat);
    }
    if row["visibility"] == "canon"
        && row["home_session_id"]
            .as_str()
            .is_some_and(|home| home != session)
    {
        return Err(Error::CrossChat);
    }
    Ok(())
}
pub fn place_after(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    anchor: &str,
    expected_graph_revision: i64,
) -> Result<Value> {
    let row = read_work(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    if row["run_state"] != "idle" || !row["chain_id"].is_null() {
        return Err(Error::Invalid("Work must be idle and unqueued"));
    }
    let anchor = read_work(tx, anchor)?;
    let chain = load_chain(tx, text(&anchor, "chain_id")?)?;
    cas(
        &one(tx, sql::CHAIN, [&chain.id])?,
        "graph_revision",
        expected_graph_revision,
    )?;
    check_chat(&row, &chain.session_id)?;
    let next = chain.chain.place_after(
        WorkId(id.into()),
        &WorkId(text(&anchor, "id")?.into()),
        &running(&[&chain]),
    )?;
    persist(tx, ctx, &[(&chain, &next)])?;
    work_result(tx, id, None)
}
#[derive(Debug, Clone)]
pub enum QueueEdit {
    MoveToNewStep {
        chain_id: String,
        work_id: String,
        index: usize,
    },
    JoinStack {
        chain_id: String,
        work_id: String,
        target: String,
    },
    SplitStack {
        chain_id: String,
        index: usize,
    },
    MoveBetween {
        chain_id: String,
        target_chain_id: String,
        work_id: String,
        placement: Placement,
    },
    Delete {
        chain_id: String,
        work_id: String,
    },
    Detach {
        chain_id: String,
        work_id: String,
        new_chain_id: String,
    },
}
/// All revisions are checked before applying any edit. Each changed Work must
/// be present in expected_works, including siblings renumbered by a chain edit.
pub fn edit_queue(
    tx: &Transaction<'_>,
    ctx: &Context,
    expected_graphs: &[(String, i64)],
    expected_works: &[(String, i64)],
    ops: &[QueueEdit],
) -> Result<Vec<Value>> {
    tx.execute_batch("SAVEPOINT wm_queue_batch")?;
    let result = edit_batch(tx, ctx, expected_graphs, expected_works, ops);
    match result {
        Ok(()) => {
            tx.execute_batch("RELEASE wm_queue_batch")?;
            let mut questions = Vec::new();
            for (chain, _) in expected_graphs {
                questions.extend(undecided_holds(tx, chain)?);
            }
            Ok(questions)
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO wm_queue_batch; RELEASE wm_queue_batch")?;
            Err(error)
        }
    }
}
fn edit_batch(
    tx: &Transaction<'_>,
    ctx: &Context,
    graphs: &[(String, i64)],
    works: &[(String, i64)],
    ops: &[QueueEdit],
) -> Result<()> {
    let mut chains = BTreeMap::new();
    for (id, expected) in graphs {
        let row = one(tx, sql::CHAIN, [id])?;
        cas(&row, "graph_revision", *expected)?;
        chains.insert(id.clone(), load_chain(tx, id)?);
    }
    for (id, expected) in works {
        cas(&read_work(tx, id)?, "revision", *expected)?;
    }
    for chain in chains.values() {
        for member in &chain.members {
            if !works.iter().any(|(id, _)| member["id"] == *id) {
                return Err(Error::Invalid("missing member revision"));
            }
        }
    }
    // Apply to pure snapshots. Revisions bump once per affected chain per batch.
    let mut next: BTreeMap<_, _> = chains
        .iter()
        .map(|(id, c)| (id.clone(), c.chain.clone()))
        .collect();
    let pins = running(&chains.values().collect::<Vec<_>>());
    let mut removed = Vec::new();
    for op in ops {
        apply_edit(op, &chains, &mut next, &pins, &mut removed)?;
    }
    let changes: Vec<_> = chains.iter().map(|(id, old)| (old, &next[id])).collect();
    persist(tx, ctx, &changes)?;
    for (id, root) in removed {
        let row = read_work(tx, &id)?;
        if matches!(row["run_state"].as_str(), Some("done" | "cancelled")) {
            if root.is_some() {
                return Err(Error::Invalid("terminal Work cannot detach"));
            }
            continue;
        }
        set_state(tx, ctx, &id, RunState::Idle, None, None, None, false)?;
        if let Some((new_chain, session)) = root {
            create_root(
                tx,
                ctx,
                &id,
                read_work(tx, &id)?["revision"]
                    .as_i64()
                    .ok_or(Error::Invalid("revision"))?,
                &new_chain,
                &session,
                QueueOrigin::Detach,
                None,
            )?;
        }
    }
    Ok(())
}
type Removed = Vec<(String, Option<(String, String)>)>;
fn apply_edit(
    op: &QueueEdit,
    chains: &BTreeMap<String, StoredChain>,
    next: &mut BTreeMap<String, Chain>,
    pins: &BTreeSet<WorkId>,
    removed: &mut Removed,
) -> Result<()> {
    let id = match op {
        QueueEdit::MoveToNewStep { chain_id, .. }
        | QueueEdit::JoinStack { chain_id, .. }
        | QueueEdit::SplitStack { chain_id, .. }
        | QueueEdit::MoveBetween { chain_id, .. }
        | QueueEdit::Delete { chain_id, .. }
        | QueueEdit::Detach { chain_id, .. } => chain_id,
    };
    let source = next
        .get(id)
        .ok_or(Error::Invalid("missing graph revision"))?
        .clone();
    let edited = match op {
        QueueEdit::MoveToNewStep { work_id, index, .. } => {
            source.move_to_new_step(&WorkId(work_id.clone()), *index, pins)?
        }
        QueueEdit::JoinStack {
            work_id, target, ..
        } => source.join_stack(&WorkId(work_id.clone()), &WorkId(target.clone()), pins)?,
        QueueEdit::SplitStack { index, .. } => source.split_stack(*index, pins)?,
        QueueEdit::MoveBetween {
            work_id,
            target_chain_id,
            placement,
            ..
        } => {
            let target = next
                .get(target_chain_id)
                .ok_or(Error::Invalid("missing target graph revision"))?;
            if chains[id].session_id != chains[target_chain_id].session_id {
                return Err(Error::CrossChat);
            }
            let (source, target) =
                source.move_between(target, &WorkId(work_id.clone()), placement.clone(), pins)?;
            next.insert(target_chain_id.clone(), target);
            source
        }
        QueueEdit::Delete { work_id, .. } => {
            removed.push((work_id.clone(), None));
            source.delete(&WorkId(work_id.clone()), pins)?
        }
        QueueEdit::Detach {
            work_id,
            new_chain_id,
            ..
        } => {
            removed.push((
                work_id.clone(),
                Some((new_chain_id.clone(), chains[id].session_id.clone())),
            ));
            source.detach(&WorkId(work_id.clone()), pins)?
        }
    };
    next.insert(id.clone(), edited);
    Ok(())
}
/// Person explicitly moves just this Work to a new conversation. No scheduler
/// runs here; the later runtime admission chooses when to execute the new root.
#[allow(
    clippy::too_many_arguments,
    reason = "two CAS tokens and explicit destinations"
)]
pub fn start_new(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    expected_graph_revision: i64,
    session: &str,
    new_chain: &str,
) -> Result<Value> {
    let row = read_work(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    if matches!(row["run_state"].as_str(), Some("running" | "in_review")) {
        return Err(Error::Running);
    }
    if let Some(chain_id) = row["chain_id"].as_str() {
        let old = load_chain(tx, chain_id)?;
        cas(
            &one(tx, sql::CHAIN, [chain_id])?,
            "graph_revision",
            expected_graph_revision,
        )?;
        let next = old.chain.detach(&WorkId(id.into()), &running(&[&old]))?;
        persist(tx, ctx, &[(&old, &next)])?;
    }
    let current = read_work(tx, id)?;
    assign_home(
        tx,
        ctx,
        id,
        current["revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?,
        Some(session),
    )?;
    // Session-private scopes move with their conversation; project scope stays.
    if row["scope_kind"] == "session" {
        let old_scope = text(&row, "scope_ref")?;
        ensure_work_counts(tx, ("session", session))?;
        for key in [
            "works".to_owned(),
            format!("run_state:{}", text(&row, "run_state")?),
        ] {
            count(tx, ("session", old_scope), &key, -1)?;
            count(tx, ("session", session), &key, 1)?;
        }
        let current = read_work(tx, id)?;
        let revision = current["revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?;
        tx.execute(sql::MOVE_SCOPE, params![id, session, ctx.now, revision])?;
        event(tx, ctx, "work", id, revision + 1, "move_conversation")?;
    }
    set_state(tx, ctx, id, RunState::Idle, None, None, None, false)?;
    create_root(
        tx,
        ctx,
        id,
        read_work(tx, id)?["revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?,
        new_chain,
        session,
        QueueOrigin::Detach,
        None,
    )?;
    work_result(tx, id, row["chain_id"].as_str())
}
