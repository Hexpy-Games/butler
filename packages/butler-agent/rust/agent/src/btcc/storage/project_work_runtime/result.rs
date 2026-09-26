mod ownership;

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{
    ProjectWorkCommittedResultInput, ProjectWorkObserveWorks, ProjectWorkToolResultEvidence,
    ToolResultRef, WorkScope,
};

use super::super::{StorageError, StorageResult};
use ownership::assert_projection_ownership;

fn invalid(code: &'static str) -> StorageError {
    StorageError::new(code, code)
}

pub(super) fn read_committed(
    db: &Connection,
    input: &ProjectWorkCommittedResultInput,
) -> StorageResult<ProjectWorkToolResultEvidence> {
    let row = db
        .query_row(
            "SELECT call.turn_id,turn.session_id,call.tool_name,call.status,call.result_json, \
         call.result_sha256,turn.rowid,call.turn_sequence FROM btcc_guided_tool_calls call \
         JOIN btcc_turns turn ON turn.turn_id=call.turn_id WHERE call.call_id=?1",
            [&input.tool_call_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some((
        turn,
        session,
        tool_name,
        status,
        body,
        hash,
        source_turn_rowid,
        source_turn_sequence,
    )) = row
    else {
        return Err(invalid("project_work_result_not_committed"));
    };
    if turn != input.turn_id || session != input.session_id {
        return Err(invalid("project_work_result_not_committed"));
    }
    if status != "completed" || super::super::work::WORK_CONTROL_TOOLS.contains(&tool_name.as_str())
    {
        return Err(invalid("project_work_result_not_attachable"));
    }
    let (Some(body), Some(hash)) = (
        body.filter(|v| !v.is_empty()),
        hash.filter(|v| !v.is_empty()),
    ) else {
        return Err(invalid("project_work_result_body_hash_mismatch"));
    };
    if crate::btcc::identity::digest(&body) != hash {
        return Err(invalid("project_work_result_body_hash_mismatch"));
    }
    Ok(ProjectWorkToolResultEvidence {
        tool_call_id: input.tool_call_id.clone(),
        tool_name,
        status: "completed",
        result_sha256: hash,
        origin_turn_id: turn,
        source_turn_rowid,
        source_turn_sequence,
    })
}

pub(super) fn observe_works(db: &Connection, input: &ProjectWorkObserveWorks) -> StorageResult<()> {
    if !valid_hash(&input.canonical_head_sha256) {
        return Err(invalid("project_work_runtime_head_invalid"));
    }
    let work_ids: HashSet<&str> = input
        .works
        .iter()
        .map(|item| item.work.work_id.as_str())
        .collect();
    let mut evidence = HashMap::new();
    for item in &input.works {
        let work = &item.work;
        let WorkScope::Project { project_ref } = &work.scope else {
            return Err(invalid("project_work_runtime_projection_mismatch"));
        };
        if project_ref.is_empty() {
            return Err(invalid("project_work_runtime_projection_mismatch"));
        }
        for reference in &work.result_refs {
            let committed = read_committed(
                db,
                &ProjectWorkCommittedResultInput {
                    turn_id: reference.origin_turn_id.clone(),
                    session_id: work.session_id.clone(),
                    tool_call_id: reference.tool_call_id.clone(),
                },
            )?;
            if committed.tool_name != reference.tool_name
                || reference.result_sha256.as_deref() != Some(committed.result_sha256.as_str())
            {
                return Err(invalid("project_work_result_reference_mismatch"));
            }
            evidence.insert(reference.result_ref.as_str(), committed);
        }
    }
    assert_projection_ownership(db, input, &work_ids)?;
    for item in &input.works {
        let work = &item.work;
        let WorkScope::Project { project_ref } = &work.scope else {
            unreachable!()
        };
        db.execute(
            "INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,ledger_project_id, \
             canonical_head_sha256,origin_turn_id,origin_message_id,objective,status, \
             current_plan_revision_id,created_at,updated_at) \
             VALUES(?1,?2,'project',?3,?4,?5,?6,?7,?8,?9,NULL,?10,?11) \
             ON CONFLICT(work_id) DO UPDATE SET session_id=excluded.session_id, \
             scope_kind=excluded.scope_kind,scope_ref=excluded.scope_ref, \
             ledger_project_id=excluded.ledger_project_id,canonical_head_sha256=excluded.canonical_head_sha256, \
             origin_turn_id=excluded.origin_turn_id,origin_message_id=excluded.origin_message_id, \
             objective=excluded.objective,status=excluded.status,current_plan_revision_id=NULL, \
             created_at=excluded.created_at,updated_at=excluded.updated_at",
            params![work.work_id, work.session_id, project_ref, input.ledger_project_id,
                input.canonical_head_sha256, work.origin.turn_id, work.origin.message_id,
                work.objective, enum_text(work.status)?, work.created_at, work.updated_at],
        ).map_err(StorageError::sqlite)?;
        for binding in &item.bindings {
            db.execute(
                "INSERT INTO btcc_guided_turn_work_bindings(binding_revision_id,turn_id,session_id, \
                 work_id,revision,is_current,bound_at) VALUES(?1,?2,?3,?4,?5,?6,?7) \
                 ON CONFLICT(binding_revision_id) DO UPDATE SET turn_id=excluded.turn_id, \
                 session_id=excluded.session_id,work_id=excluded.work_id,revision=excluded.revision, \
                 is_current=excluded.is_current,bound_at=excluded.bound_at",
                params![binding.binding_revision_id, binding.turn_id, work.session_id, work.work_id,
                    binding.revision, i64::from(binding.is_current), binding.bound_at],
            ).map_err(StorageError::sqlite)?;
        }
        for (index, reference) in work.result_refs.iter().enumerate() {
            repair_result(
                db,
                &work.work_id,
                index as u64 + 1,
                reference,
                evidence
                    .get(reference.result_ref.as_str())
                    .ok_or_else(|| invalid("project_work_result_reference_mismatch"))?,
            )?;
        }
    }
    let Some(head) = input
        .works
        .iter()
        .find(|item| item.work.work_id == input.session_head_work_id)
    else {
        return Err(invalid("project_work_runtime_head_invalid"));
    };
    db.execute(
        "INSERT INTO btcc_guided_work_session_heads(session_id,work_id,updated_at) VALUES(?1,?2,?3) \
         ON CONFLICT(session_id) DO UPDATE SET work_id=excluded.work_id,updated_at=excluded.updated_at",
        params![head.work.session_id, head.work.work_id, head.work.updated_at],
    ).map_err(StorageError::sqlite)?;
    Ok(())
}

fn repair_result(
    db: &Connection,
    work_id: &str,
    sequence: u64,
    reference: &ToolResultRef,
    evidence: &ProjectWorkToolResultEvidence,
) -> StorageResult<()> {
    db.execute(
        "INSERT INTO btcc_guided_work_results(result_ref,work_id,sequence,tool_call_id, \
         origin_turn_id,source_turn_rowid,source_turn_sequence,attached_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(result_ref) DO UPDATE SET \
         work_id=excluded.work_id,sequence=excluded.sequence,tool_call_id=excluded.tool_call_id, \
         origin_turn_id=excluded.origin_turn_id,source_turn_rowid=excluded.source_turn_rowid, \
         source_turn_sequence=excluded.source_turn_sequence,attached_at=excluded.attached_at",
        params![
            reference.result_ref,
            work_id,
            sequence,
            reference.tool_call_id,
            reference.origin_turn_id,
            evidence.source_turn_rowid,
            evidence.source_turn_sequence,
            reference.attached_at
        ],
    )
    .map_err(StorageError::sqlite)?;
    Ok(())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn enum_text<T: serde::Serialize>(value: T) -> StorageResult<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| invalid("project_work_runtime_projection_mismatch"))
}
