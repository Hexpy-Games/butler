//! Explicit principal changes belong to one admitted run, never a conversation default.
use super::query::sql;
use crate::btcc::authority::contracts::{AuthorityResult, DecisionWrite};
use crate::btcc::{AccessMode, TurnRecord};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

struct Lineage {
    root: String,
    mode: AccessMode,
    ceiling: AccessMode,
    scheduled: bool,
}

fn parse(value: &str) -> AuthorityResult<AccessMode> {
    AccessMode::parse(value)
        .ok_or_else(|| crate::btcc::AuthorityError::policy("permission_mode_invalid"))
}

fn admitted(db: &Connection, turn: &str) -> AuthorityResult<(String, AccessMode, bool)> {
    let (session, controls, context): (String, String, String) = db
        .query_row(
            "SELECT session_id,model_selection_json,context_json FROM btcc_turns WHERE turn_id=?1",
            [turn],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sql)?;
    let decode = |text: &str| {
        serde_json::from_str::<Value>(text).map_err(|e| {
            crate::btcc::AuthorityError::policy("permission_context_invalid").with_source(e)
        })
    };
    let controls = decode(&controls)?;
    let context = decode(&context)?;
    let mode = parse(
        controls
            .pointer("/controls/accessMode")
            .and_then(Value::as_str)
            .unwrap_or("read_only"),
    )?;
    let policy = context
        .get("executionPolicy")
        .filter(|policy| !policy.is_null());
    let policy = parse(
        policy
            .map(|policy| {
                policy
                    .get("accessMode")
                    .and_then(Value::as_str)
                    .unwrap_or("read_only")
            })
            .unwrap_or(mode.as_str()),
    )?;
    let mode = mode.narrower(policy);
    Ok((
        session,
        mode,
        context.get("scheduleRun").is_some_and(|v| !v.is_null()),
    ))
}

fn lineage(db: &Connection, turn: &str) -> AuthorityResult<Lineage> {
    let mut id = turn.to_owned();
    let mut seen = std::collections::HashSet::new();
    let mut ceiling = AccessMode::FullAccess;
    loop {
        if !seen.insert(id.clone()) {
            return Err(crate::btcc::AuthorityError::policy(
                "permission_lineage_invalid",
            ));
        }
        let (session, mode, scheduled) = admitted(db, &id)?;
        let parent: Option<(String, String, String)> = db
            .query_row(
                "SELECT r.parent_turn_id,r.relation_id,d.packet_json FROM btcc_session_relations r
             JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.child_session_id=?1",
                [session],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(sql)?;
        if scheduled || parent.is_none() {
            return Ok(Lineage {
                root: id,
                mode,
                ceiling,
                scheduled,
            });
        }
        let (parent, relation, packet) = parent
            .ok_or_else(|| crate::btcc::AuthorityError::policy("permission_lineage_invalid"))?;
        let limit = delegation_limit(db, &relation, &parent, &packet)?;
        if let Some(limit) = limit {
            ceiling = ceiling.narrower(limit);
        }
        id = parent;
    }
}

pub(in crate::btcc::storage) fn delegation_limit(
    db: &Connection,
    relation: &str,
    parent: &str,
    packet: &str,
) -> AuthorityResult<Option<AccessMode>> {
    let limit: Option<(bool, Option<String>)> = db
        .query_row(
            "SELECT access_limit_recorded,access_limit_mode FROM btcc_subsession_delegations WHERE relation_id=?1",
            [relation],
            |row| Ok((row.get(0)?,row.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    match limit {
        Some((true, limit)) => limit.map(|v| parse(&v)).transpose(),
        _ => legacy_limit(db, parent, packet),
    }
}

fn legacy_limit(
    db: &Connection,
    parent: &str,
    packet: &str,
) -> AuthorityResult<Option<AccessMode>> {
    let packet: Value = serde_json::from_str(packet).map_err(|e| {
        crate::btcc::AuthorityError::policy("permission_packet_invalid").with_source(e)
    })?;
    let mode = parse(
        packet
            .get("access_mode")
            .and_then(Value::as_str)
            .unwrap_or("read_only"),
    )?;
    let (_, inherited, _) = admitted(db, parent)?;
    Ok((mode.rank() < inherited.rank()).then_some(mode))
}

pub(in crate::btcc) fn effective(
    db: &Connection,
    turn: &str,
) -> AuthorityResult<Option<AccessMode>> {
    let lineage = lineage(db, turn)?;
    if lineage.scheduled {
        return Ok(None);
    }
    let mode: Option<String> = db.query_row(
        "SELECT composer_access_mode FROM btcc_authority_requests WHERE composer_root_turn_id=?1 ORDER BY composer_revision DESC LIMIT 1",
        [&lineage.root], |row| row.get(0)).optional().map_err(sql)?;
    mode.map(|v| parse(&v).map(|m| m.narrower(lineage.ceiling)))
        .transpose()
}

pub(super) fn record(db: &Connection, write: &DecisionWrite) -> AuthorityResult<()> {
    let Some(mode) = &write.composer_mode else {
        return Ok(());
    };
    let turn: String = db
        .query_row(
            "SELECT source_turn_id FROM btcc_authority_requests WHERE request_ref=?1",
            [&write.request_ref],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let lineage = lineage(db, &turn)?;
    if lineage.scheduled {
        return Ok(());
    }
    let current = effective(db, &lineage.root)?.unwrap_or(lineage.mode);
    if *mode != current {
        db.execute("UPDATE btcc_authority_requests SET composer_root_turn_id=?1,composer_access_mode=?2,
            composer_revision=(SELECT COALESCE(MAX(composer_revision),0)+1 FROM btcc_authority_requests WHERE composer_root_turn_id=?1)
            WHERE request_ref=?3",
            params![lineage.root,mode.as_str(),write.request_ref]).map_err(sql)?;
    }
    Ok(())
}

pub(in crate::btcc::storage) fn restrict_delegation(
    db: &Connection,
    input: &super::super::subsessions::SubsessionCreate,
) -> AuthorityResult<()> {
    let (_, admitted, _) = admitted(db, &input.parent_turn_id)?;
    let inherited = effective(db, &input.parent_turn_id)?.unwrap_or(admitted);
    let requested = &input.packet.access_mode;
    let limit = (requested.rank() < inherited.rank()).then_some(requested.as_str());
    db.execute(
        "UPDATE btcc_subsession_delegations SET access_limit_mode=?2,access_limit_recorded=1 WHERE relation_id=?1",
        params![input.relation_id, limit],
    )
    .map_err(sql)?;
    Ok(())
}

pub(in crate::btcc::storage) fn project(
    db: &Connection,
    turn: &mut TurnRecord,
) -> AuthorityResult<()> {
    if let Some(mode) = effective(db, &turn.turn_id)? {
        turn.model_selection
            .controls
            .insert("accessMode".into(), serde_json::json!(mode));
        if let Some(policy) = turn
            .context
            .get_mut("executionPolicy")
            .and_then(Value::as_object_mut)
        {
            policy.insert("accessMode".into(), serde_json::json!(mode));
        }
    }
    Ok(())
}

/// Preserve the admission of the exact card even when its answer narrows future calls.
pub(super) fn remember_request(
    db: &Connection,
    record: &crate::btcc::authority::contracts::AuthorityRecord,
) -> AuthorityResult<()> {
    let (_, admitted, _) = admitted(db, &record.source_turn_id)?;
    let mode = effective(db, &record.source_turn_id)?.unwrap_or(admitted);
    db.execute("UPDATE btcc_authority_requests SET execution_access_mode=COALESCE(execution_access_mode,?2) WHERE request_ref=?1",
        params![record.request_ref,mode.as_str()]).map_err(sql)?;
    Ok(())
}

pub(in crate::btcc) fn approved_execution(
    db: &Connection,
    request: &str,
    turn: &str,
    occurrence: &str,
    capability: &str,
) -> AuthorityResult<Option<AccessMode>> {
    let mode: Option<Option<String>> = db
        .query_row(
            "SELECT execution_access_mode FROM btcc_authority_requests
         WHERE request_ref=?1 AND source_turn_id=?2 AND source_call_id=?3
         AND capability=?4 AND decision='allowed' AND close_reason IS NULL",
            params![request, turn, occurrence, capability],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    match mode {
        None => Ok(None),
        Some(Some(mode)) => parse(&mode).map(Some),
        Some(None) => admitted(db, turn).map(|(_, mode, _)| Some(mode)),
    }
}
