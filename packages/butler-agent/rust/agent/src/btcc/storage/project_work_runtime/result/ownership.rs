use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{ProjectWorkObserveWorks, ToolResultRef, WorkScope};

use super::super::super::{StorageError, StorageResult};
use super::invalid;

pub(super) fn assert_result_ownership(
    db: &Connection,
    expected: &[(&str, u64, &ToolResultRef)],
    work_id: &str,
) -> StorageResult<()> {
    let mut statement = db
        .prepare(
            "SELECT result_ref,work_id,sequence,tool_call_id,origin_turn_id,attached_at \
         FROM btcc_guided_work_results WHERE work_id=?1 OR result_ref=?2 OR tool_call_id=?3",
        )
        .map_err(StorageError::sqlite)?;
    for (owner, sequence, reference) in expected {
        let rows = statement
            .query_map(
                params![work_id, reference.result_ref, reference.tool_call_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .map_err(StorageError::sqlite)?;
        for row in rows {
            let (result_ref, row_work, row_sequence, call, turn, attached) =
                row.map_err(StorageError::sqlite)?;
            if !expected.iter().any(|(w, n, r)| {
                *w == row_work
                    && *n == row_sequence
                    && r.result_ref == result_ref
                    && r.tool_call_id == call
                    && r.origin_turn_id == turn
                    && r.attached_at == attached
            }) {
                return Err(invalid("project_work_runtime_ownership_conflict"));
            }
        }
        let _ = (owner, sequence);
    }
    Ok(())
}

pub(super) fn assert_projection_ownership(
    db: &Connection,
    input: &ProjectWorkObserveWorks,
    work_ids: &HashSet<&str>,
) -> StorageResult<()> {
    let session_ids: HashSet<&str> = input
        .works
        .iter()
        .map(|item| item.work.session_id.as_str())
        .collect();
    for item in &input.works {
        let work = &item.work;
        let WorkScope::Project { project_ref } = &work.scope else {
            return Err(invalid("project_work_runtime_projection_mismatch"));
        };
        let row = db.query_row(
            "SELECT session_id,scope_kind,scope_ref,ledger_project_id FROM btcc_guided_works WHERE work_id=?1",
            [&work.work_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
        ).optional().map_err(StorageError::sqlite)?;
        if row.is_some_and(|(session, kind, scope, ledger)| {
            session != work.session_id
                || kind != "project"
                || scope != *project_ref
                || (ledger.is_none()
                    && input.legacy_import_claim_work_id.as_deref() != Some(work.work_id.as_str()))
                || ledger.is_some_and(|id| id != input.ledger_project_id)
        }) {
            return Err(invalid("project_work_runtime_ownership_conflict"));
        }
        let expected = work
            .result_refs
            .iter()
            .enumerate()
            .map(|(i, r)| (work.work_id.as_str(), i as u64 + 1, r))
            .collect::<Vec<_>>();
        if expected.is_empty() {
            let extra = db
                .query_row(
                    "SELECT 1 FROM btcc_guided_work_results WHERE work_id=?1 LIMIT 1",
                    [&work.work_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(StorageError::sqlite)?;
            if extra.is_some() {
                return Err(invalid("project_work_runtime_ownership_conflict"));
            }
        } else {
            assert_result_ownership(db, &expected, &work.work_id)?;
        }
    }
    let Some(_head) = input
        .works
        .iter()
        .find(|item| item.work.work_id == input.session_head_work_id)
    else {
        return Err(invalid("project_work_runtime_head_invalid"));
    };
    let mut heads = db.prepare(
        "SELECT head.session_id,head.work_id,work.session_id,work.scope_kind,work.scope_ref,work.ledger_project_id \
         FROM btcc_guided_work_session_heads head LEFT JOIN btcc_guided_works work ON work.work_id=head.work_id",
    ).map_err(StorageError::sqlite)?;
    for row in heads
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(StorageError::sqlite)?
    {
        let (session, id, work_session, kind, scope, ledger) = row.map_err(StorageError::sqlite)?;
        if !session_ids.contains(session.as_str()) && !work_ids.contains(id.as_str()) {
            continue;
        }
        let expected = input
            .works
            .iter()
            .find(|item| item.work.session_id == session)
            .ok_or_else(|| invalid("project_work_runtime_ownership_conflict"))?;
        let WorkScope::Project { project_ref } = &expected.work.scope else {
            return Err(invalid("project_work_runtime_projection_mismatch"));
        };
        if work_session.as_deref() != Some(expected.work.session_id.as_str())
            || kind.as_deref() != Some("project")
            || scope.as_deref() != Some(project_ref.as_str())
            || ledger.as_deref() != Some(input.ledger_project_id.as_str())
        {
            return Err(invalid("project_work_runtime_ownership_conflict"));
        }
    }
    let bindings = input
        .works
        .iter()
        .flat_map(|item| {
            item.bindings.iter().map(move |binding| {
                (
                    item.work.work_id.as_str(),
                    item.work.session_id.as_str(),
                    binding,
                )
            })
        })
        .collect::<Vec<_>>();
    let mut rows = db
        .prepare(
            "SELECT binding_revision_id,turn_id,session_id,work_id,revision,is_current,bound_at \
         FROM btcc_guided_turn_work_bindings",
        )
        .map_err(StorageError::sqlite)?;
    for row in rows
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(StorageError::sqlite)?
    {
        let (id, turn, session, owner, revision, current, at) =
            row.map_err(StorageError::sqlite)?;
        let touches = work_ids.contains(owner.as_str())
            || bindings.iter().any(|(_, _, binding)| {
                binding.binding_revision_id == id
                    || (binding.turn_id == turn && binding.revision == revision)
                    || (current == 1 && binding.is_current && binding.turn_id == turn)
            });
        if !touches {
            continue;
        }
        if !bindings.iter().any(|(work_id, session_id, binding)| {
            binding.binding_revision_id == id
                && binding.turn_id == turn
                && *session_id == session
                && *work_id == owner
                && binding.revision == revision
                && binding.bound_at == at
        }) {
            return Err(invalid("project_work_runtime_ownership_conflict"));
        }
    }
    Ok(())
}
