use super::{
    execution::{CriterionRef, sql},
    tool_ops::TaskPatch,
    *,
};
use rusqlite::params;
use std::collections::BTreeSet;

pub fn edit_task_fields(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected: i64,
    patch: &TaskPatch,
    confirm_draft: bool,
) -> Result<Value> {
    let row = parts::editable_task(tx, id)?;
    cas(&row, "revision", expected)?;
    if patch.acceptance_refs.is_some()
        && matches!(row["status"].as_str(), Some("running" | "in_review"))
    {
        return Err(Error::Running);
    }
    if confirm_draft
        && (row["status"] != "draft" || patch.acceptance_refs.as_ref().is_none_or(Vec::is_empty))
    {
        return Err(Error::Invalid(
            "draft confirmation requires acceptance_refs",
        ));
    }
    if let Some(criteria) = &patch.acceptance_refs {
        bind_criteria(tx, id, criteria)?;
    }
    let status = if confirm_draft {
        if row["step_index"] == 0 {
            "pending"
        } else {
            "waiting"
        }
    } else {
        text(&row, "status")?
    };
    tx.execute(
        sql::EDIT_TASK,
        params![
            id,
            patch.title.as_deref().unwrap_or(text(&row, "title")?),
            patch
                .description
                .as_deref()
                .unwrap_or(text(&row, "description")?),
            status,
            ctx.now,
            expected
        ],
    )?;
    event(tx, ctx, "task", id, expected + 1, "edit")?;
    read_task(tx, id)
}
/// Binding validation is independent of the model's claim that a ref belongs
/// to this Work. Only active, immutable criteria in its Spec tree can bind.
pub fn bind_criteria(tx: &Transaction<'_>, task: &str, criteria: &[CriterionRef]) -> Result<()> {
    validate_criteria(tx, task, criteria)?;
    tx.execute(sql::DELETE_CRITERIA, [task])?;
    for criterion in criteria {
        tx.execute(
            sql::INSERT_CRITERION,
            params![
                task,
                criterion.node_id,
                criterion.node_revision,
                criterion.criterion_id
            ],
        )?;
    }
    Ok(())
}
pub(super) fn validate_task_criteria(db: &Connection, task: &str) -> Result<()> {
    let bound = rows(db, sql::CRITERIA, [task])?
        .into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<Vec<CriterionRef>, _>>()?;
    validate_criteria(db, task, &bound)
}
fn validate_criteria(db: &Connection, task: &str, criteria: &[CriterionRef]) -> Result<()> {
    if criteria.is_empty() {
        return Err(Error::Invalid("Task needs acceptance_refs"));
    }
    let unique: BTreeSet<_> = criteria.iter().collect();
    if unique.len() != criteria.len() {
        return Err(Error::Invalid("duplicate criterion_ref"));
    }
    let row = read_task(db, task)?;
    for criterion in criteria {
        let spec = one(
            db,
            sql::CRITERION,
            params![
                criterion.node_id,
                criterion.node_revision,
                criterion.criterion_id
            ],
        )?;
        if spec["work_id"] != row["work_id"] || spec["active_revision"] != criterion.node_revision {
            return Err(Error::Invalid(
                "criterion_ref is outside the active Work Spec",
            ));
        }
    }
    Ok(())
}
