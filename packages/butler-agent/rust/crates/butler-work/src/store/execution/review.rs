use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CriterionRef {
    pub node_id: String,
    pub node_revision: i64,
    pub criterion_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CriterionResult {
    pub criterion_ref: CriterionRef,
    pub met: bool,
    pub evidence_refs: Vec<String>,
    pub note: String,
}
pub struct ReviewInput<'a> {
    pub result_revision: i64,
    pub review_id: &'a str,
    pub accept: bool,
    pub judgments: &'a [CriterionResult],
}
pub fn review_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    session: &str,
    input: &ReviewInput<'_>,
) -> Result<Value> {
    let ReviewInput {
        result_revision,
        review_id,
        accept,
        judgments,
    } = *input;
    ensure_task_effect(tx, id, session)?;
    let task = read_task(tx, id)?;
    if task["status"] != "in_review"
        || parts::task_parts(tx, id)?
            .iter()
            .any(|p| !matches!(p["status"].as_str(), Some("completed" | "cancelled")))
    {
        return Err(Error::Invalid("parts must finish before Task review"));
    }
    let result = one(tx, sql::LATEST_RESULT, [id])?;
    cas(&result, "revision", result_revision)?;
    if result["task_revision"] != task["revision"] || result["spec_ref"] != task["spec_ref"] {
        return Err(Error::Invalid("result is stale; submit again"));
    }
    let bound: BTreeSet<CriterionRef> = rows(tx, sql::CRITERIA, [id])?
        .into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<_, _>>()?;
    let judged: BTreeSet<_> = judgments.iter().map(|j| j.criterion_ref.clone()).collect();
    if bound.is_empty() || bound != judged || judgments.len() != judged.len() {
        return Err(Error::Invalid(
            "review must judge every bound criterion exactly once",
        ));
    }
    if accept
        && judgments
            .iter()
            .any(|j| !j.met || j.evidence_refs.is_empty())
    {
        return Err(Error::Invalid(
            "accept requires every criterion met with evidence",
        ));
    }
    let verdict = if accept { "accepted" } else { "rejected" };
    tx.execute(
        sql::INSERT_REVIEW,
        params![
            review_id,
            id,
            revision(&task)?,
            text(&task, "spec_ref")?,
            text(&result, "id")?,
            result_revision,
            ctx.actor.to_string(),
            serde_json::to_string(judgments)?,
            verdict,
            ctx.now
        ],
    )?;
    event(tx, ctx, "review", review_id, 0, "review")?;
    one(tx, sql::REVIEW, [review_id])
}
pub fn complete_task(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    session: &str,
    review_id: &str,
    reported: bool,
) -> Result<Value> {
    ensure_task_effect(tx, id, session)?;
    let task = read_task(tx, id)?;
    let review = one(tx, sql::REVIEW, [review_id])?;
    let result = one(tx, sql::LATEST_RESULT, [id])?;
    if review["task_id"] != id
        || review["verdict"] != "accepted"
        || review["task_revision"] != task["revision"]
        || review["spec_ref"] != task["spec_ref"]
        || review["result_id"] != result["id"]
        || review["result_revision"] != result["revision"]
    {
        return Err(Error::Invalid("review_not_accepted"));
    }
    if parts::task_parts(tx, id)?
        .iter()
        .any(|p| !matches!(p["status"].as_str(), Some("completed" | "cancelled")))
    {
        return Err(Error::Invalid("parts must finish before Task completion"));
    }
    tx.execute(
        sql::FINISH_TASK_ATTEMPTS,
        params![id, "succeeded", ctx.now, Option::<&str>::None],
    )?;
    tx.execute(sql::TASK_COMPLETION, params![id, revision(&task)?])?;
    transition(
        tx,
        ctx,
        id,
        revision(&task)?,
        TaskStatus::Completed,
        reported,
        None,
    )
}
