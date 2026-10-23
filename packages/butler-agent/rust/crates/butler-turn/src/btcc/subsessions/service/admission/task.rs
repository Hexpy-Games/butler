//! Whole-Task assignments reuse the native child dispatch and report protocol.
use super::*;

#[allow(clippy::too_many_arguments, reason = "atomic assignment context")]
pub(super) fn assign_target(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    input: &AssignmentRequest,
    ids: &delegation::DelegationIds,
    work: &str,
    task: &str,
    part: Option<&str>,
    attempt: &str,
) -> store::Result<()> {
    let child = store::ExecutionScope {
        session_id: &ids.child_session_id,
        turn_id: &ids.child_turn_id,
    };
    let tier = if let Some(part) = part {
        store::tiers::delegation_floor(tx, work)?;
        let row = store::read_part(tx, part)?;
        store::assign_part(
            tx,
            ctx,
            part,
            revision(&row)?,
            &input.parent_session_id,
            &child,
            attempt,
        )?;
        2
    } else {
        let row = store::read_task(tx, task)?;
        store::assign_task(tx, ctx, task, revision(&row)?, &child, attempt)?;
        tx.execute(
            store::execution_sql::REGISTER_REPORT,
            params![attempt, task, input.parent_session_id],
        )?;
        store::open_task_session(tx, ctx, task)?;
        at(&store::read_work(tx, work)?, "/tier")
            .as_u64()
            .unwrap_or(1)
            .max(1) as u8
    };
    store::tiers::admit(
        tx,
        ctx,
        &ids.child_session_id,
        work,
        tier,
        if part.is_some() {
            "delegated"
        } else {
            "task_session"
        },
    )?;
    Ok(())
}
fn revision(row: &Value) -> store::Result<i64> {
    at(row, "/revision")
        .as_i64()
        .ok_or(store::Error::Invalid("revision"))
}
