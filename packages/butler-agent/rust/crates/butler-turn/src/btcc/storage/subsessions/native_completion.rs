//! Result and delivery commit together on the Work writer lane.
use super::*;
use crate::btcc::subsessions::assignment::Child;
use butler_core::json::at;
use butler_work::store;

pub(super) fn settle(
    tx: &store::Transaction<'_>,
    child: &Child,
    completion: &ChildCompletion,
) -> store::Result<String> {
    let Child::Assigned(assigned) = child else {
        let legacy:Option<String>=tx.query_row("SELECT result_id FROM btcc_steward_results WHERE relation_id=?1 AND child_turn_id=?2 ORDER BY created_at DESC LIMIT 1",params![child.relation_id,completion.turn],|r|r.get(0)).optional()?;
        return Ok(legacy
            .unwrap_or_else(|| completion::turn_result_id(&completion.session, &completion.turn)));
    };
    let attempt: (String, String, Option<String>) = tx.query_row(
        crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_1,
        params![assigned.task_id, completion.session, completion.turn],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let result_id = format!("result-{}", attempt.0);
    if tx
        .query_row(
            crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_2,
            [&result_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(result_id);
    }
    let ctx = store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: serde_json::json!({"session":completion.session,"turn":completion.turn}),
    };
    let task = store::read_task(tx, &assigned.task_id)?;
    if !at(&task, "/handoff_to_session_id").is_null() {
        let checkpoint = store::put_body(
            tx,
            &serde_json::json!({
                "summary":completion.summary,"evidence_refs":completion.evidence_refs,
                "parts":store::parts::task_parts(tx,&assigned.task_id)?,
                "task":task,
            })
            .to_string(),
        )?;
        store::complete_handoff(tx, &ctx, &assigned.task_id, &checkpoint)?;
    } else if attempt.1 == "running" {
        finish(
            tx,
            &ctx,
            assigned,
            completion,
            &attempt.0,
            attempt.2.as_deref(),
        )?;
    }
    Ok(result_id)
}

fn finish(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    child: &crate::btcc::subsessions::assignment::ChildAssignment,
    completion: &ChildCompletion,
    attempt: &str,
    part: Option<&str>,
) -> store::Result<()> {
    let scope = store::ExecutionScope {
        session_id: &completion.session,
        turn_id: &completion.turn,
    };
    let reason = completion
        .failure_reason
        .as_deref()
        .unwrap_or(&completion.summary);
    match completion.status.as_str() {
        "success" => {
            let summary = store::put_body(tx, &completion.summary)?;
            store::submit_task(
                tx,
                ctx,
                &child.task_id,
                &scope,
                &store::Submission {
                    part_id: part,
                    result_id: &format!("submission-{attempt}"),
                    result_refs: &[summary],
                    evidence_refs: &completion.evidence_refs,
                },
            )?;
        }
        "failed" if completion.failure_code.as_deref() == Some("child_turn_interrupted") => {
            store::recover_session(tx, ctx, &completion.session, store::PreviousShutdown::Crash)?;
        }
        "failed" => {
            if let Some(part) = part {
                store::fail_part(tx, ctx, part, &completion.session, reason)?;
            } else {
                store::fail_task(tx, ctx, &child.task_id, &completion.session, reason)?;
            }
            tx.execute(
                crate::btcc::storage::native_sql::STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_3,
                params![attempt, reason],
            )?;
        }
        "cancelled" | "blocked" => {
            let reason = if completion.status == "cancelled" {
                "cancelled"
            } else {
                reason
            };
            store::block_task(
                tx,
                ctx,
                &child.task_id,
                part,
                &completion.session,
                reason,
                Some(reason),
            )?;
            if completion.status == "cancelled"
                && let Some(part) = part
            {
                tx.execute(
                    store::execution_sql::PART_STATE,
                    params![part, "cancelled", Option::<&str>::None],
                )?;
            }
        }
        _ => return Err(store::Error::Invalid("child completion status")),
    }
    Ok(())
}

/// A model can block its assignment before the transport delivers the final answer.
/// Resolve that durable outcome in the same transaction as its parent receipt.
pub(super) fn resolve_outcome(
    tx: &store::Transaction<'_>,
    child: &Child,
    completion: &mut ChildCompletion,
) -> store::Result<()> {
    let Child::Assigned(child) = child else {
        return Ok(());
    };
    let task = store::read_task(tx, &child.task_id)?;
    if child.part_id.is_none()
        && at(&task, "/assignee_session_id").as_str() != Some(completion.session.as_str())
    {
        completion.status = "cancelled".into();
        completion.summary = "다른 대화로 옮겨졌습니다".into();
        completion.failure_code = None;
        completion.failure_reason = None;
        return Ok(());
    }
    if completion.status != "success" {
        return Ok(());
    }
    if matches!(at(&task, "/status").as_str(), Some("blocked" | "failed")) {
        completion.status = at(&task, "/status").as_str().unwrap_or("failed").into();
        completion.failure_reason = at(&task, "/blocked_reason")
            .as_str()
            .or(at(&task, "/failure_reason").as_str())
            .map(str::to_owned);
    }
    Ok(())
}
