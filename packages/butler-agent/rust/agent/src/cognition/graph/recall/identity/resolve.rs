//! As-of identity decisions, including revocation preimage authority.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};

use crate::cognition::{
    CognitionError, CognitionResult,
    recall::{IdentityReadScope, IdentityResolution, IdentitySourceBinding},
};

use super::{
    super::db_error,
    records::{self, Decision, HistoryRef},
};

struct IdentityResolutionContext<'a, SourceCurrent, Now> {
    db: &'a Connection,
    scope: &'a IdentityReadScope,
    parse_date: &'a dyn Fn(&str) -> f64,
    source_current: &'a mut SourceCurrent,
    now_millis: &'a mut Now,
    visited: &'a mut HashSet<String>,
}

pub(super) fn resolve(
    db: &Connection,
    node_id: &str,
    scope: &IdentityReadScope,
    parse_date: &dyn Fn(&str) -> f64,
    source_current: &mut impl FnMut(&IdentitySourceBinding) -> bool,
    now_millis: &mut impl FnMut() -> i64,
) -> CognitionResult<IdentityResolution> {
    let mut visited = HashSet::new();
    let mut context = IdentityResolutionContext {
        db,
        scope,
        parse_date,
        source_current,
        now_millis,
        visited: &mut visited,
    };
    internal(&mut context, node_id)
}

fn internal<SourceCurrent, Now>(
    context: &mut IdentityResolutionContext<'_, SourceCurrent, Now>,
    node_id: &str,
) -> CognitionResult<IdentityResolution>
where
    SourceCurrent: FnMut(&IdentitySourceBinding) -> bool,
    Now: FnMut() -> i64,
{
    let head = context
        .db
        .query_row(
            "SELECT identity_history_job_id,identity_history_ref FROM memory_nodes WHERE id=?1",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| CognitionError::new("memory_graph_unavailable", "memory_node_missing"))?;
    let mut head = head
        .0
        .zip(head.1)
        .map(|(job_ref, decision_ref)| HistoryRef {
            job_ref,
            decision_ref,
        });
    while let Some(current) = head {
        if (context.now_millis)() >= context.scope.deadline_at || context.visited.len() >= 64 {
            return Ok(result(node_id, true));
        }
        let key = format!("{}\0{}", current.job_ref, current.decision_ref);
        if !context.visited.insert(key) {
            return Ok(result(node_id, true));
        }
        let Some(record) = records::find(context.db, &current)? else {
            return Ok(result(node_id, true));
        };
        if record.recorded_at <= context.scope.as_of
            && record.source_observed_at <= context.scope.as_of
        {
            let (in_scope, authoritative) = records::scope_status(
                context.db,
                &record,
                context.scope,
                context.parse_date,
                context.source_current,
            )?;
            if in_scope && !authoritative {
                return Ok(result(node_id, true));
            }
            if authoritative {
                if record.operation == "apply"
                    && let Some(canonical) = &record.literal_canonical
                {
                    return internal(context, canonical);
                }
                if record.operation == "revoke" || record.operation == "invalidate" {
                    return authorized_preimage(context, node_id, &record);
                }
            }
        }
        head = record.previous_head;
    }
    Ok(result(node_id, false))
}

fn authorized_preimage<SourceCurrent, Now>(
    context: &mut IdentityResolutionContext<'_, SourceCurrent, Now>,
    literal: &str,
    record: &Decision,
) -> CognitionResult<IdentityResolution>
where
    SourceCurrent: FnMut(&IdentitySourceBinding) -> bool,
    Now: FnMut() -> i64,
{
    let Some(restored) = record.resulting_direct_redirect.as_deref() else {
        return Ok(result(literal, false));
    };
    let Some(target_ref) = &record.target_decision else {
        return Ok(result(literal, true));
    };
    let Some(target) = records::find(context.db, target_ref)? else {
        return Ok(result(literal, true));
    };
    let Some(previous_head) = &target.previous_head else {
        return Ok(result(literal, true));
    };
    let Some(previous) = owning_apply(context.db, previous_head, restored)? else {
        return Ok(result(literal, true));
    };
    let (in_scope, authoritative) = records::scope_status(
        context.db,
        &previous,
        context.scope,
        context.parse_date,
        context.source_current,
    )?;
    if !in_scope
        || !authoritative
        || context.visited.len() >= 64
        || (context.now_millis)() >= context.scope.deadline_at
    {
        return Ok(result(literal, true));
    }
    internal(context, restored)
}

fn owning_apply(
    db: &Connection,
    initial: &HistoryRef,
    redirect: &str,
) -> CognitionResult<Option<Decision>> {
    let mut head = Some(initial.clone());
    let mut visited = HashSet::new();
    while let Some(current) = head {
        if visited.len() >= 64
            || !visited.insert(format!("{}\0{}", current.job_ref, current.decision_ref))
        {
            return Ok(None);
        }
        let Some(record) = records::find(db, &current)? else {
            return Ok(None);
        };
        if record.operation == "apply"
            && record.resulting_direct_redirect.as_deref() == Some(redirect)
        {
            return Ok(Some(record));
        }
        if (record.operation == "revoke" || record.operation == "invalidate")
            && record.resulting_direct_redirect.as_deref() == Some(redirect)
            && let Some(target_head) = &record.target_decision
            && let Some(target) = records::find(db, target_head)?
        {
            head = target.previous_head;
            continue;
        }
        head = record.previous_head;
    }
    Ok(None)
}

fn result(node_id: &str, partial: bool) -> IdentityResolution {
    IdentityResolution {
        node_id: node_id.to_owned(),
        partial,
    }
}
