//! Runtime settlement of parent Work from the terminal Steward result.
use super::{StorageError, StorageResult, common, mutation, read};
use crate::btcc::{ActionStatus, ChildRole, StoredSubsessionDelegation, WorkStage};
use rusqlite::{Connection, params};

pub(in crate::btcc::storage) fn settle(
    db: &Connection,
    relation: &StoredSubsessionDelegation,
    (result_id, result_turn): (&str, &str),
    status: &str,
    summary: &str,
    evidence: &[String],
    now: &str,
) -> StorageResult<()> {
    if relation.packet.child_role != ChildRole::Steward {
        return Ok(());
    }
    let Some(parent) = &relation.packet.parent_work_ref else {
        return Ok(());
    };
    if common::work(db, &parent.work_id)?.is_none() {
        return Ok(());
    }
    let work = read::view(db, &parent.work_id)?;
    if matches!(work.scope, crate::btcc::WorkScope::Project { .. }) {
        return Ok(());
    }
    if !matches!(
        work.status,
        crate::btcc::DurableWorkStatus::Open | crate::btcc::DurableWorkStatus::Blocked
    ) {
        return Ok(());
    }
    let Some(plan) = &work.current_plan else {
        return Ok(());
    };
    if plan.plan_revision_id != parent.plan_revision_id {
        return Ok(());
    }
    let disposition = match status {
        "success" | "completed" => "completed",
        "cancelled" | "abandoned" => "abandoned",
        _ => "blocked",
    };
    let mut actions = work.action_progress.clone();
    for action in &mut actions {
        action.status = match disposition {
            "completed" => ActionStatus::Done,
            "abandoned" => ActionStatus::Skipped,
            _ => ActionStatus::Blocked,
        };
        action.note = Some(summary.into());
    }
    let condition = if disposition == "blocked" {
        let child = common::work(db, &relation.root_work_id)?
            .map(|_| read::view(db, &relation.root_work_id))
            .transpose()?;
        child
            .and_then(|work| work.latest_disposition)
            .and_then(|d| d.next_condition)
            .or_else(|| Some(summary.into()))
    } else {
        None
    };
    let material = Settlement {
        disposition,
        summary,
        actions: &actions,
        condition: condition.as_deref(),
        evidence,
        now,
    };
    record_progress(
        db,
        &parent.work_id,
        result_turn,
        &plan.plan_revision_id,
        result_id,
        material,
    )?;
    if disposition != "abandoned" {
        record_disposition(db, &parent.work_id, result_turn, result_id, material)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Settlement<'a> {
    disposition: &'a str,
    summary: &'a str,
    actions: &'a [crate::btcc::ActionProgress],
    condition: Option<&'a str>,
    evidence: &'a [String],
    now: &'a str,
}

fn record_progress(
    db: &Connection,
    work: &str,
    turn: &str,
    plan: &str,
    result_id: &str,
    material: Settlement<'_>,
) -> StorageResult<()> {
    let Settlement {
        disposition,
        summary,
        actions,
        condition,
        now,
        ..
    } = material;
    mutation::insert_progress(
        db,
        mutation::ProgressInput {
            work_id: work,
            plan_revision_id: plan,
            stage: WorkStage::Reporting,
            actions,
            summary,
            next: condition.unwrap_or(""),
            result_sequence: common::latest_result_sequence(db, work)?,
            origin_turn_id: turn,
            identity: result_id,
            now,
        },
    )?;
    db.execute(
        "UPDATE btcc_guided_works SET status=?2,updated_at=?3 WHERE work_id=?1",
        params![work, disposition, now],
    )
    .map_err(StorageError::sqlite)?;
    Ok(())
}

fn record_disposition(
    db: &Connection,
    work: &str,
    turn: &str,
    result: &str,
    material: Settlement<'_>,
) -> StorageResult<()> {
    let Settlement {
        disposition,
        summary,
        actions,
        condition,
        evidence,
        now,
    } = material;
    let id = format!("steward-result-disposition:{result}");
    let revision = common::next_revision(db, "btcc_guided_work_disposition_revisions", work)?;
    db.execute("INSERT INTO btcc_guided_work_disposition_revisions (disposition_revision_id,work_id,revision,result_sequence,disposition,summary,material_fingerprint,runtime_owned_open,action_updates_json,remaining_actions_json,next_condition,evidence_refs_json,evidence_snapshot_json,followups_json,origin_turn_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,'',0,?7,'[]',?8,?9,?9,'[]',?10,?11)",
        params![id,work,revision,common::latest_result_sequence(db,work)?,disposition,summary,
            common::stable(&actions)?,condition,common::stable(&evidence)?,turn,now]).map_err(StorageError::sqlite)?;
    let fingerprint = crate::btcc::disposition_material_fingerprint(&read::view(db, work)?)
        .map_err(|error| {
            StorageError::new(
                crate::btcc::StorageCode::DurableWorkSerializationFailed,
                error.message(),
            )
        })?;
    db.execute("UPDATE btcc_guided_work_disposition_revisions SET material_fingerprint=?2 WHERE disposition_revision_id=?1",
        params![id,fingerprint]).map_err(StorageError::sqlite)?;
    Ok(())
}
