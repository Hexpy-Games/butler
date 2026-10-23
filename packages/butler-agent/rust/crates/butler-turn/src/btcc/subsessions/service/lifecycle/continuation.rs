//! Parent steers retain the relation and Task without reopening completed parts.
use crate::btcc::{storage::native_sql, subsessions::assignment::ChildAssignment};
use butler_core::json::at;
use butler_work::{store, work_types::TaskKind};
use rusqlite::{OptionalExtension, params};

pub(super) fn claim(
    tx: &store::Transaction<'_>,
    assigned: &ChildAssignment,
    session: &str,
    turn: &str,
) -> store::Result<()> {
    let ctx = super::admission::context();
    let part: Option<String> = tx.query_row(
        native_sql::SUBSESSIONS_SERVICE_LATEST_PART,
        params![assigned.task_id, session],
        |row| row.get(0),
    )?;
    if let Some(part) = &part
        && store::continue_part_turn(tx, &ctx, part, session, turn)?
    {
        return Ok(());
    }
    let instruction = store::pending_instructions(tx, session, false)?
        .into_iter()
        .find(|row| {
            crate::btcc::storage::direction_turn_id(at(row, "/id").as_str().unwrap_or_default())
                == turn
        })
        .ok_or(store::Error::Invalid("child turn has no assignment"))?;
    let task = store::read_task(tx, &assigned.task_id)?;
    if let Some(part) = part {
        claim_part(tx, &ctx, assigned, &part, &instruction, session, turn)?;
    } else {
        store::start_task(
            tx,
            &ctx,
            &assigned.task_id,
            revision(&task)?,
            &store::ExecutionScope {
                session_id: session,
                turn_id: turn,
            },
            &format!("attempt:{turn}"),
        )?;
    }
    Ok(())
}

fn claim_part(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    assigned: &ChildAssignment,
    part: &str,
    instruction: &serde_json::Value,
    session: &str,
    turn: &str,
) -> store::Result<()> {
    let row = store::read_part(tx, part)?;
    let completed = at(&row, "/status") == "completed";
    if completed && at(instruction, "/mode") != "steer" {
        return Err(store::Error::Invalid(
            "The assigned part is completed. Delegate a new part for the continuation.",
        ));
    }
    let task = store::read_task(tx, &assigned.task_id)?;
    if at(&task, "/status") == "in_review" && !completed {
        return Err(store::Error::Invalid(
            "The Task is in review. Finish its review before continuing execution.",
        ));
    }
    if !matches!(at(&task, "/status").as_str(), Some("running" | "in_review")) || completed {
        resume_task(tx, ctx, assigned, &task, turn)?;
    }
    let next = if completed {
        let id = format!("part:{turn}");
        store::add_part(
            tx,
            ctx,
            &store::NewPart {
                id: &id,
                task_id: &assigned.task_id,
                kind: serde_json::from_value::<TaskKind>(at(&row, "/kind").clone())?,
                title: at(&row, "/title")
                    .as_str()
                    .ok_or(store::Error::Invalid("part title"))?,
                after_part_ids: &[part.to_owned()],
            },
        )?;
        id
    } else {
        tx.execute(
            store::execution_sql::PART_STATE,
            params![part, "pending", Option::<&str>::None],
        )?;
        part.to_owned()
    };
    store::assign_part(
        tx,
        ctx,
        &next,
        revision(&store::read_part(tx, &next)?)?,
        &assigned.parent_session_id,
        &store::ExecutionScope {
            session_id: session,
            turn_id: turn,
        },
        &format!("attempt:{turn}"),
    )?;
    Ok(())
}

fn resume_task(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    assigned: &ChildAssignment,
    task: &serde_json::Value,
    turn: &str,
) -> store::Result<()> {
    let lease = tx
        .query_row(store::execution_sql::LEASE, [&assigned.task_id], |_| Ok(()))
        .optional()?
        .is_some();
    if lease {
        store::transition(
            tx,
            ctx,
            &assigned.task_id,
            revision(task)?,
            butler_work::work_types::TaskStatus::Running,
            false,
            None,
        )?;
    } else {
        store::start_task(
            tx,
            ctx,
            &assigned.task_id,
            revision(task)?,
            &store::ExecutionScope {
                session_id: &assigned.parent_session_id,
                turn_id: &assigned.parent_turn_id,
            },
            &format!("parent-attempt:{turn}"),
        )?;
    }
    Ok(())
}

fn revision(row: &serde_json::Value) -> store::Result<i64> {
    at(row, "/revision")
        .as_i64()
        .ok_or(store::Error::Invalid("revision"))
}
