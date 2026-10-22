//! A delegated result reports only after receipt delivery and its parent turn.
use super::*;

pub fn has_pending_reports(db: &Connection, task: &str) -> Result<bool> {
    Ok(db
        .query_row(sql::PENDING_REPORT, [task], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn deliver_delegated_result(tx: &Transaction<'_>, ctx: &Context, attempt: &str) -> Result<()> {
    let task: Option<String> = tx
        .query_row(sql::DELIVER_REPORT, params![attempt, ctx.now], |r| r.get(0))
        .optional()?;
    report_ready(tx, ctx, task)
}

pub fn end_delegated_delivery(
    tx: &Transaction<'_>,
    ctx: &Context,
    attempt: &str,
    parent: &str,
) -> Result<()> {
    let task: Option<String> = tx
        .query_row(sql::END_REPORT, params![attempt, parent, ctx.now], |r| {
            r.get(0)
        })
        .optional()?;
    report_ready(tx, ctx, task)
}

fn report_ready(tx: &Transaction<'_>, ctx: &Context, task: Option<String>) -> Result<()> {
    if let Some(task) = task
        && !has_pending_reports(tx, &task)?
        && read_task(tx, &task)?["status"] == "completed"
    {
        report_task(tx, ctx, &task)?;
    }
    Ok(())
}
