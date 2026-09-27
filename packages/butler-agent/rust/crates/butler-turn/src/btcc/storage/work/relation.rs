use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{
    ContinueWorkCommand, ReplacePlanCommand, StartWorkCommand, WorkTurnScope, WorkView,
};

use super::{StorageError, StorageResult, common, read, tool_result};
use crate::btcc::StorageCode;

pub(super) fn start(
    db: &Connection,
    command: &StartWorkCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<WorkView> {
    let input = &command.input;
    if let Some(work) = replay(
        db,
        &input.mutation_call_id,
        "start_work",
        &command.request_sha256,
    )? {
        tool_result::backfill(
            db,
            &work.id,
            &input.scope,
            &input.mutation_call_id,
            input.backfill_tool_call_ids.as_deref().unwrap_or(&[]),
            clock,
        )?;
        return read::view(db, &work.id);
    }
    let turn = common::relation_turn(db, &input.scope)?;
    if common::bound(db, &input.scope.turn_id)?.is_some() {
        return Err(common::error(
            StorageCode::DurableWorkRelationSelected,
            "Durable Work relation is already selected for this Turn",
        ));
    }
    if let Some(head) = common::head(db, &input.scope.session_id)?
        && head.is_open()
    {
        abandon(db, &head.id, clock)?;
    }
    let work = create_and_bind(
        db,
        &input.scope,
        &input.mutation_call_id,
        &input.objective,
        &turn,
        clock,
    )?;
    record(
        db,
        &input.mutation_call_id,
        "start_work",
        &command.request_sha256,
        &work.id,
        clock,
    )?;
    tool_result::backfill(
        db,
        &work.id,
        &input.scope,
        &input.mutation_call_id,
        input.backfill_tool_call_ids.as_deref().unwrap_or(&[]),
        clock,
    )?;
    read::view(db, &work.id)
}

pub(super) fn continue_work(
    db: &Connection,
    command: &ContinueWorkCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<WorkView> {
    let input = &command.input;
    if let Some(work) = replay(
        db,
        &input.mutation_call_id,
        "continue_work",
        &command.request_sha256,
    )? {
        tool_result::backfill(
            db,
            &work.id,
            &input.scope,
            &input.mutation_call_id,
            input.backfill_tool_call_ids.as_deref().unwrap_or(&[]),
            clock,
        )?;
        return read::view(db, &work.id);
    }
    let turn = common::relation_turn(db, &input.scope)?;
    let bound = common::bound(db, &input.scope.turn_id)?;
    let head = common::head(db, &input.scope.session_id)?;
    if let Some(bound) = &bound
        && bound.id != input.work_id
    {
        return Err(common::error(
            StorageCode::DurableWorkRelationOther,
            "Durable Work relation is already selected for another Work",
        ));
    }
    let target = head
        .filter(|head| {
            head.id == input.work_id && head.is_open() && common::matches_scope(head, &input.scope)
        })
        .ok_or_else(|| {
            common::error(
                StorageCode::DurableWorkContinuationNotCurrent,
                "Durable Work continuation target is not the current open Work",
            )
        })?;
    if bound.is_none() {
        bind(db, &turn, &target.id, clock)?;
    }
    record(
        db,
        &input.mutation_call_id,
        "continue_work",
        &command.request_sha256,
        &target.id,
        clock,
    )?;
    tool_result::backfill(
        db,
        &target.id,
        &input.scope,
        &input.mutation_call_id,
        input.backfill_tool_call_ids.as_deref().unwrap_or(&[]),
        clock,
    )?;
    read::view(db, &target.id)
}

pub(super) fn bind_open(
    db: &Connection,
    scope: &WorkTurnScope,
    expected: Option<&str>,
    clock: &dyn Fn() -> String,
) -> StorageResult<Option<WorkView>> {
    let turn = common::turn(db, scope)?;
    let bound = common::bound(db, &scope.turn_id)?;
    let head = common::head(db, &scope.session_id)?;
    if expected.is_some_and(|id| {
        bound.as_ref().is_none_or(|b| b.id != id) && head.as_ref().is_none_or(|h| h.id != id)
    }) {
        return Ok(None);
    }
    if let Some(bound) = bound {
        if expected.is_some_and(|id| bound.id != id) {
            return Ok(None);
        }
        if head.as_ref().is_none_or(|head| head.id != bound.id) {
            return Err(common::error(
                StorageCode::DurableWorkBindingNotHead,
                "Durable Work Turn binding is no longer the Session head",
            ));
        }
        if !common::matches_scope(&bound, scope) {
            return Err(common::error(
                StorageCode::DurableWorkScopeMismatch,
                "Durable Work Turn scope does not match its bound Work",
            ));
        }
        return if bound.is_open() {
            read::view(db, &bound.id).map(Some)
        } else {
            Ok(None)
        };
    }
    let Some(head) = head.filter(|head| {
        head.is_open()
            && expected.is_none_or(|id| head.id == id)
            && common::matches_scope(head, scope)
    }) else {
        return Ok(None);
    };
    bind(db, &turn, &head.id, clock)?;
    read::view(db, &head.id).map(Some)
}

pub(super) fn abandon_bound_turn(
    db: &Connection,
    turn_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<Option<WorkView>> {
    let Some(bound) = common::bound(db, turn_id)? else {
        return Ok(None);
    };
    if bound.is_open() {
        abandon(db, &bound.id, clock)?;
    }
    read::view(db, &bound.id).map(Some)
}

pub(super) fn select_for_plan(
    db: &Connection,
    command: &ReplacePlanCommand,
    clock: &dyn Fn() -> String,
) -> StorageResult<common::WorkRow> {
    let input = &command.input;
    let turn = common::relation_turn(db, &input.scope)?;
    let bound = common::bound(db, &input.scope.turn_id)?;
    let head = common::head(db, &input.scope.session_id)?;
    if command.start_new
        && let Some(bound) = &bound
    {
        if turn_committed(db, &input.scope.turn_id, &bound.id)? {
            return Err(common::error(
                StorageCode::DurableWorkRelationCommitted,
                "Durable Work continuation is already committed for this Turn; continue the current Work or start new Work in a fresh Turn",
            ));
        }
        return Err(common::error(
            StorageCode::DurableWorkRelationSelected,
            "Durable Work relation is already selected for this Turn; startNew cannot switch Work; continue the current Work or start new Work in a fresh Turn",
        ));
    }
    if bound.as_ref().is_some_and(|work| !work.is_open()) {
        return Err(common::error(
            StorageCode::DurableWorkTerminalRelation,
            "Durable Work relation is already selected for a terminal Work; start new Work in a fresh Turn",
        ));
    }
    if bound
        .as_ref()
        .zip(head.as_ref())
        .is_some_and(|(bound, head)| bound.id != head.id)
    {
        return Err(common::error(
            StorageCode::DurableWorkBindingNotHead,
            "Durable Work Turn binding is no longer the Session head",
        ));
    }
    let current = bound.as_ref().or(head.as_ref());
    if let Some(current) = current
        && !command.start_new
        && !common::matches_scope(current, &input.scope)
    {
        return Err(common::error(
            StorageCode::DurableWorkScopeChanged,
            "Durable Work scope changed; startNew is required",
        ));
    }
    if command.start_new {
        if let Some(current) = current
            && current.is_open()
        {
            abandon(db, &current.id, clock)?;
        }
        let work = create_and_bind(
            db,
            &input.scope,
            &input.mutation_call_id,
            &input.objective,
            &turn,
            clock,
        )?;
        record(
            db,
            &input.mutation_call_id,
            "start_work",
            &command.request_sha256,
            &work.id,
            clock,
        )?;
        return Ok(work);
    }
    if let Some(current) = current
        && current.is_open()
    {
        if bound.is_none() {
            bind(db, &turn, &current.id, clock)?;
            record(
                db,
                &input.mutation_call_id,
                "continue_work",
                &command.request_sha256,
                &current.id,
                clock,
            )?;
        }
        return Ok(current.clone());
    }
    let work = create_and_bind(
        db,
        &input.scope,
        &input.mutation_call_id,
        &input.objective,
        &turn,
        clock,
    )?;
    record(
        db,
        &input.mutation_call_id,
        "start_work",
        &command.request_sha256,
        &work.id,
        clock,
    )?;
    Ok(work)
}

pub(super) fn require_bound(
    db: &Connection,
    scope: &WorkTurnScope,
    allow_completed: bool,
) -> StorageResult<common::WorkRow> {
    common::relation_turn(db, scope)?;
    let bound = common::bound(db, &scope.turn_id)?.ok_or_else(|| {
        common::error(
            StorageCode::DurableWorkNotBound,
            format!("Durable Work is not bound to Turn: {}", scope.turn_id),
        )
    })?;
    if common::head(db, &scope.session_id)?.is_none_or(|head| head.id != bound.id) {
        return Err(common::error(
            StorageCode::DurableWorkBindingNotHead,
            "Durable Work Turn binding is no longer the Session head",
        ));
    }
    if !(bound.is_open() || allow_completed && bound.status == "completed") {
        return Err(common::error(
            StorageCode::DurableWorkNotOpen,
            format!("Durable Work is not open: {}", bound.id),
        ));
    }
    if !common::matches_scope(&bound, scope) {
        return Err(common::error(
            StorageCode::DurableWorkScopeMismatch,
            "Durable Work Turn scope does not match its bound Work",
        ));
    }
    Ok(bound)
}

fn replay(
    db: &Connection,
    call_id: &str,
    operation: &str,
    fingerprint: &str,
) -> StorageResult<Option<common::WorkRow>> {
    let row = db.query_row("SELECT operation, request_sha256, work_id FROM btcc_guided_work_relation_commands WHERE mutation_call_id = ?1", [call_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .optional().map_err(StorageError::sqlite)?;
    let Some((stored_operation, stored_fingerprint, work_id)) = row else {
        return Ok(None);
    };
    if stored_operation != operation || stored_fingerprint != fingerprint {
        return Err(common::error(
            StorageCode::DurableWorkRelationIdentityConflict,
            format!("Durable Work relation identity conflict: {call_id}"),
        ));
    }
    common::work(db, &work_id)
}

fn record(
    db: &Connection,
    call_id: &str,
    operation: &str,
    fingerprint: &str,
    work_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    db.execute("INSERT INTO btcc_guided_work_relation_commands (mutation_call_id, operation, request_sha256, work_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![call_id, operation, fingerprint, work_id, clock()]).map_err(StorageError::sqlite)?;
    Ok(())
}

fn create_and_bind(
    db: &Connection,
    scope: &WorkTurnScope,
    call_id: &str,
    objective: &str,
    turn: &common::TurnRow,
    clock: &dyn Fn() -> String,
) -> StorageResult<common::WorkRow> {
    let work_id = common::record_id("work", call_id);
    let now = clock();
    db.execute("INSERT INTO btcc_guided_works (work_id, session_id, scope_kind, scope_ref, origin_turn_id, origin_message_id, objective, status, created_at, updated_at) VALUES (?1, ?2, 'session', ?2, ?3, ?4, ?5, 'open', ?6, ?6)", params![work_id, scope.session_id, scope.turn_id, turn.message_id, objective, now]).map_err(StorageError::sqlite)?;
    db.execute("INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(session_id) DO UPDATE SET work_id = excluded.work_id, updated_at = excluded.updated_at", params![scope.session_id, work_id, now]).map_err(StorageError::sqlite)?;
    bind(db, turn, &work_id, clock)?;
    common::head(db, &scope.session_id)?.ok_or_else(|| {
        common::error(
            StorageCode::DurableWorkHeadMissing,
            "Durable Work session head was not persisted",
        )
    })
}

pub(super) fn abandon(
    db: &Connection,
    work_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    let now = clock();
    let changed = db.execute("UPDATE btcc_guided_works SET status = 'abandoned', updated_at = ?1 WHERE work_id = ?2 AND status IN ('open', 'blocked')", params![now, work_id]).map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(common::error(
            StorageCode::DurableWorkAbandonFailed,
            format!("Durable Work could not be abandoned: {work_id}"),
        ));
    }
    super::super::authority::close_pending_source_work_requests(db, work_id, &clock())?;
    Ok(())
}

fn bind(
    db: &Connection,
    turn: &common::TurnRow,
    work_id: &str,
    clock: &dyn Fn() -> String,
) -> StorageResult<()> {
    let existing: Option<String> = db.query_row("SELECT work_id FROM btcc_guided_turn_work_bindings WHERE turn_id = ?1 AND is_current = 1", [&turn.id], |row| row.get(0)).optional().map_err(StorageError::sqlite)?;
    if existing.as_deref() == Some(work_id) {
        return Ok(());
    }
    let revision: u64 = db.query_row("SELECT COALESCE(MAX(revision), 0) + 1 FROM btcc_guided_turn_work_bindings WHERE turn_id = ?1", [&turn.id], |row| row.get(0)).map_err(StorageError::sqlite)?;
    db.execute("UPDATE btcc_guided_turn_work_bindings SET is_current = 0 WHERE turn_id = ?1 AND is_current = 1", [&turn.id]).map_err(StorageError::sqlite)?;
    db.execute("INSERT INTO btcc_guided_turn_work_bindings (binding_revision_id, turn_id, session_id, work_id, revision, is_current, bound_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)", params![common::record_id("binding", &format!("{}\0{revision}\0{work_id}", turn.id)), turn.id, turn.session_id, work_id, revision, clock()]).map_err(StorageError::sqlite)?;
    Ok(())
}

fn turn_committed(db: &Connection, turn_id: &str, work_id: &str) -> StorageResult<bool> {
    let value: Option<i64> = db.query_row("SELECT 1 FROM (SELECT work_id, origin_turn_id FROM btcc_guided_work_plan_revisions UNION ALL SELECT work_id, origin_turn_id FROM btcc_guided_work_checkpoint_revisions UNION ALL SELECT work_id, origin_turn_id FROM btcc_guided_work_review_revisions UNION ALL SELECT work_id, origin_turn_id FROM btcc_guided_work_results) progress WHERE progress.work_id = ?1 AND progress.origin_turn_id = ?2 LIMIT 1", params![work_id, turn_id], |row| row.get(0)).optional().map_err(StorageError::sqlite)?;
    Ok(value.is_some())
}
