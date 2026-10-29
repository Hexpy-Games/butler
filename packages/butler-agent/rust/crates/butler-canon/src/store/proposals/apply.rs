use super::*;

pub fn apply(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    project: &str,
    by: Option<&str>,
) -> Result<Value> {
    let row = get(tx, id)?;
    if row["state"] == "applied" {
        return Ok(row["document"]["result"].clone());
    }
    if row["state"] != "open" {
        return Err(Error::Invalid("proposal is no longer open"));
    }
    let mut document = row["document"].clone();
    let changes = document["changes"]
        .as_array()
        .ok_or(Error::Invalid("changes required"))?;
    let creating = changes.iter().any(|c| c["op"] == "project.create");
    if creating && !changes.iter().any(|c| c["op"] == "epic.create") {
        return Err(Error::Invalid("new project requires an epic"));
    }
    tx.execute_batch("SAVEPOINT proposal_apply")?;
    let result = batch(
        tx,
        ctx,
        project,
        row["session_id"].as_str().unwrap_or_default(),
        changes,
    );
    let result = match result {
        Ok(value) => {
            tx.execute_batch("RELEASE proposal_apply")?;
            value
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO proposal_apply; RELEASE proposal_apply")?;
            if let Error::Conflict { current } = error {
                transition(tx, ctx, id, "stale", by)?;
                return Ok(conflict_result(&current));
            }
            return Err(error);
        }
    };
    document["result"] = result.clone();
    tx.execute(
        "UPDATE canon_proposals SET project_id=?2,changes_json=?3 WHERE id=?1",
        params![id, project, document.to_string()],
    )?;
    transition(tx, ctx, id, "applied", by)?;
    Ok(result)
}
fn batch(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    session: &str,
    changes: &[Value],
) -> Result<Value> {
    let mut applied = Vec::new();
    let mut bound = Vec::new();
    for change in changes {
        let result = operations::execute(tx, ctx, project, change)?;
        if let Some(reference) = result["epic_ref"].as_str() {
            let id = reference
                .strip_prefix("canon:epic/")
                .ok_or(Error::Invalid("epic_ref"))?;
            bind(tx, ctx, id, session)?;
            if !bound.contains(&json!(reference)) {
                bound.push(json!(reference));
            }
        }
        applied.push(result);
    }
    Ok(
        json!({"ok":true,"state":"applied","applied":applied,"bound":bound,"message":APPLIED_MESSAGE}),
    )
}

/// Validate a draft against the same writers without retaining any mutations.
pub(super) fn validate(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    changes: &[Value],
) -> Result<()> {
    if changes.iter().any(|c| c["op"] == "project.create")
        && !changes.iter().any(|c| c["op"] == "epic.create")
    {
        return Err(Error::Invalid("new project requires an epic"));
    }
    tx.execute_batch("SAVEPOINT proposal_validate")?;
    let result = changes
        .iter()
        .try_for_each(|change| operations::execute(tx, ctx, project, change).map(|_| ()));
    tx.execute_batch("ROLLBACK TO proposal_validate; RELEASE proposal_validate")?;
    result
}
