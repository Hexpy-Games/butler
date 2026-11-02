//! Bundles reuse immutable delegated-result evidence and indexed result identities.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, params};

use super::super::{StorageError, StorageResult};
use super::contracts::*;
use crate::btcc::StorageCode;

fn invalid() -> StorageError {
    error(StorageCode::OperationResultMissingOrScopeMismatch)
}

/// The ancestry walk follows indexed child identities toward their parents.
fn bundle(db: &Connection, turn: &str, evidence: &str) -> StorageResult<String> {
    let id = evidence.strip_prefix("evidence:").ok_or_else(invalid)?;
    db.query_row(
        "WITH RECURSIVE ancestors(session) AS (
           SELECT r.child_session_id FROM btcc_steward_results x
           JOIN btcc_session_relations r ON r.relation_id=x.relation_id WHERE x.result_id=?1
           UNION
           SELECT r.parent_session_id FROM btcc_session_relations r
           JOIN ancestors a ON r.child_session_id=a.session
         ) SELECT x.acceptance_evidence_json FROM btcc_steward_results x
         JOIN btcc_session_relations r ON r.relation_id=x.relation_id
         WHERE x.result_id=?1 AND EXISTS (
           SELECT 1 FROM ancestors a JOIN btcc_session_relations edge ON edge.child_session_id=a.session
           JOIN btcc_turns caller ON caller.session_id=edge.parent_session_id WHERE caller.turn_id=?2
         )",
        params![id, turn], |row| row.get(0),
    ).optional().map_err(StorageError::sqlite)?.ok_or_else(invalid)
}

struct Item {
    call: String,
    turn: String,
    tool: String,
    status: String,
    started: String,
    arguments: String,
    hash: String,
}

fn item(db: &Connection, reference: &str) -> StorageResult<Item> {
    db.query_row(
        "SELECT c.call_id,c.turn_id,c.tool_name,c.status,c.started_at,c.arguments_json,
                COALESCE(c.result_sha256,'')
         FROM btcc_guided_tool_calls c WHERE c.call_id=COALESCE(
           (SELECT tool_call_id FROM btcc_guided_work_results WHERE result_ref=?1),?1)",
        [reference],
        |r| {
            Ok(Item {
                call: r.get(0)?,
                turn: r.get(1)?,
                tool: r.get(2)?,
                status: r.get(3)?,
                started: r.get(4)?,
                arguments: r.get(5)?,
                hash: r.get(6)?,
            })
        },
    )
    .optional()
    .map_err(StorageError::sqlite)?
    .map(Ok)
    .unwrap_or_else(|| effect(db, reference))
}

fn effect(db: &Connection, reference: &str) -> StorageResult<Item> {
    use sha2::{Digest, Sha256};
    db.query_row(
        "SELECT capability,'completed',created_at,receipt_json,result_json FROM btcc_guided_effects WHERE receipt_id=?1 AND status='applied'",
        [reference], |r| {
            let result: String = r.get(4)?;
            Ok(Item { call: reference.into(), turn: String::new(),
                tool: r.get(0)?, status: r.get(1)?, started: r.get(2)?, arguments: r.get(3)?,
                hash: format!("{:x}", Sha256::digest(result.as_bytes())) })
        },
    ).optional().map_err(StorageError::sqlite)?.ok_or_else(invalid)
}

fn references(raw: &str) -> StorageResult<Vec<String>> {
    serde_json::from_str(raw).map_err(|e| {
        StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()).with_source(e)
    })
}

pub(super) fn discover(
    db: &Connection,
    input: &OperationResultDiscoveryInput,
    evidence: &str,
) -> StorageResult<OperationResultDiscovery> {
    let raw = bundle(db, &input.turn_id, evidence)?;
    let refs = references(&raw)?;
    let through = refs.len() as f64;
    let start = butler_core::json::saturating_usize(input.cursor).min(refs.len());
    let limit = butler_core::json::saturating_usize(input.limit);
    let end = start.saturating_add(limit).min(refs.len());
    let entries = refs
        .iter()
        .skip(start)
        .take(end - start)
        .enumerate()
        .map(|(index, reference)| {
            let item = item(db, reference)?;
            let result_sha256 = result_hash(db, &item)?;
            Ok(OperationResultDiscoveryEntry {
                call_id: item.call,
                origin_turn_id: item.turn,
                ordinal: (start + index + 1) as f64,
                tool_name: item.tool,
                status: item.status,
                started_at: item.started,
                request_preview: item.arguments.chars().take(240).collect(),
                result_sha256,
            })
        })
        .collect::<StorageResult<Vec<_>>>()?;
    Ok(OperationResultDiscovery {
        entries,
        through,
        next_cursor: (end < refs.len()).then_some(end as f64),
    })
}

/// Only exact members receive the child's existing scope for the existing reader.
pub(super) fn authorize_read(
    db: &Connection,
    input: &ExactResultRangeInput,
    evidence: &str,
) -> StorageResult<ExactResultRangeInput> {
    let refs = references(&bundle(db, &input.turn_id, evidence)?)?;
    if !refs.contains(&input.result_ref) {
        return Err(invalid());
    }
    let mut authorized = input.clone();
    let item = item(db, &input.result_ref)?;
    authorized.turn_id = item.turn;
    if let Some((session, kind, scope)) = db
        .query_row(
            "SELECT w.session_id,w.scope_kind,w.scope_ref FROM btcc_guided_work_results r
         JOIN btcc_guided_works w ON w.work_id=r.work_id WHERE r.result_ref=?1",
            [&input.result_ref],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?
    {
        authorized.session_id = Some(session);
        authorized.project_ref = (kind == "project").then_some(scope);
    }
    Ok(authorized)
}

pub(crate) fn manifest(
    db: &Connection,
    result: &str,
    refs: &[String],
    summary: &str,
) -> StorageResult<String> {
    if refs.is_empty() {
        return Ok("evidence: none".into());
    }
    let counts = counts(db, refs)?;
    let line = format!(
        "evidence: evidence:{result} — {} items ({counts})",
        refs.len()
    );
    if line.len() > 3 * 1024 {
        return Err(StorageError::new(
            StorageCode::SubsessionResultInvalid,
            "Evidence manifest exceeds 3 KB",
        ));
    }
    let cited = cited(db, result, refs, summary)?;
    Ok(format!(
        "{line}{}\nEvidence is bundled; read any item exactly with list_operation_results evidence=<id>.",
        if cited.is_empty() {
            String::new()
        } else {
            format!("\ncited: {}", cited.join(", "))
        }
    ))
}

fn mentions(text: &str, reference: &str) -> bool {
    text.match_indices(reference).any(|(start, value)| {
        let end = start + value.len();
        let identity = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_' | ':');
        !text[..start].chars().next_back().is_some_and(identity)
            && !text[end..].chars().next().is_some_and(identity)
    })
}

fn counts(db: &Connection, refs: &[String]) -> StorageResult<String> {
    let mut counts = BTreeMap::<String, usize>::new();
    let mut sites = BTreeSet::new();
    for reference in refs {
        let item = item(db, reference)?;
        *counts.entry(item.tool.clone()).or_default() += 1;
        if item.tool == "web_read"
            && let Some(host) = site_host(db, &item)?
        {
            sites.insert(host);
        }
    }
    let counts = counts
        .into_iter()
        .map(|(tool, count)| {
            if tool == "web_read" {
                format!("{tool} {count} from {} sites", sites.len())
            } else {
                format!("{tool} {count}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    Ok(counts)
}

fn cited(
    db: &Connection,
    result: &str,
    refs: &[String],
    summary: &str,
) -> StorageResult<Vec<String>> {
    let disposition: Option<String> = db.query_row(
        "SELECT d.summary || char(10) || COALESCE(d.next_condition,'') || char(10)
                || d.remaining_actions_json || char(10) || d.followups_json || char(10) || d.action_updates_json
         FROM btcc_steward_results r
         JOIN btcc_guided_turn_work_bindings b ON b.turn_id=r.child_turn_id AND b.is_current=1
         JOIN btcc_guided_work_disposition_revisions d ON d.work_id=b.work_id
         WHERE r.result_id=?1 AND d.origin_turn_id=r.child_turn_id ORDER BY d.revision DESC LIMIT 1",
        [result], |row| row.get(0),
    ).optional().map_err(StorageError::sqlite)?;
    let text = format!("{summary}\n{}", disposition.unwrap_or_default());
    let cited = refs
        .iter()
        .filter(|reference| mentions(&text, reference))
        .cloned()
        .collect::<Vec<_>>();
    Ok(cited)
}

fn result_hash(db: &Connection, item: &Item) -> StorageResult<String> {
    use sha2::{Digest, Sha256};
    if !item.hash.is_empty() {
        return Ok(item.hash.clone());
    }
    let body: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE call_id=?1 AND result_json IS NOT NULL",
        [&item.call], |row| row.get(0),
    ).optional().map_err(StorageError::sqlite)?.ok_or_else(invalid)?;
    Ok(format!("{:x}", Sha256::digest(body.as_bytes())))
}

fn site_host(db: &Connection, item: &Item) -> StorageResult<Option<String>> {
    let source: Option<String> = db
        .query_row(
            "SELECT COALESCE(NULLIF(json_extract(result_json,'$.source_url'),''),
                         NULLIF(json_extract(result_json,'$.final_url'),''),
                         json_extract(arguments_json,'$.url'))
         FROM btcc_guided_tool_calls WHERE call_id=?1",
            [&item.call],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    Ok(source
        .and_then(|url| url::Url::parse(&url).ok())
        .and_then(|url| url.host_str().map(str::to_owned)))
}
