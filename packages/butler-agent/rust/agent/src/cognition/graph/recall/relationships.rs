//! Source-qualified correction, conflict, explicit-priority and support reads.

use std::collections::HashSet;

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult,
    recall::{RecallRequest, RecallTimeBasis},
};

use super::{db_error, scope};

#[derive(Debug)]
pub(in crate::cognition) struct RelationshipState {
    pub superseded: bool,
    pub explicit_priority: bool,
    pub explicit_rule_source_ids: HashSet<String>,
    pub priority_source_ids: HashSet<String>,
    pub qualifications: Vec<String>,
}

struct RelationshipRow {
    relation: String,
    source_node_id: String,
    target_node_id: String,
    candidate_node_id: String,
    evidence_source_id: String,
}

pub(super) fn state(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
    now_iso: &str,
) -> CognitionResult<RelationshipState> {
    let rows = relationship_rows(db, input, episode_id)?;
    let superseded = rows
        .iter()
        .any(|row| row.relation == "supersedes" && row.target_node_id == row.candidate_node_id);
    let current_correction = rows
        .iter()
        .any(|row| row.relation == "supersedes" && row.source_node_id == row.candidate_node_id);
    let conflicting = rows.iter().any(|row| row.relation == "contradicts");
    let historical = !superseded && later_supersession(db, input, episode_id, now_iso)?;
    let explicit_rule_source_ids = explicit_rules(db, input, episode_id)?;
    let mut priority_source_ids = rows
        .iter()
        .filter(|row| row.relation == "contradicts" || row.source_node_id == row.candidate_node_id)
        .map(|row| row.evidence_source_id.clone())
        .collect::<HashSet<_>>();
    priority_source_ids.extend(explicit_rule_source_ids.iter().cloned());
    let mut qualifications = Vec::new();
    if historical {
        qualifications.push("historical".into());
    }
    if superseded {
        qualifications.push("superseded".into());
    }
    if conflicting {
        qualifications.push("conflicting".into());
    }
    Ok(RelationshipState {
        superseded,
        explicit_priority: current_correction || !explicit_rule_source_ids.is_empty(),
        explicit_rule_source_ids,
        priority_source_ids,
        qualifications,
    })
}

fn relationship_rows(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
) -> CognitionResult<Vec<RelationshipRow>> {
    let candidate = scope::source(input, "candidate_source", "candidate_chunk");
    let evidence = scope::source(input, "s", "c");
    let relationship_at = input
        .time
        .as_ref()
        .filter(|time| time.basis == RecallTimeBasis::Event)
        .map_or(input.as_of.as_str(), |time| time.from.as_str());
    let sql = format!(
        r"
        SELECT DISTINCT e.rel_type, e.source_node_id, e.target_node_id,
          candidate.node_id, ee.chunk_source_id
        FROM memory_evidence candidate
        JOIN memory_chunk_sources candidate_source
          ON candidate_source.source_id=candidate.source_id
        JOIN memory_chunks candidate_chunk
          ON candidate_chunk.memory_chunk_id=candidate_source.episode_id
          AND candidate_chunk.current_revision=candidate_source.revision
        JOIN edges e ON e.source_node_id=candidate.node_id
          OR e.target_node_id=candidate.node_id
        JOIN edge_evidence ee ON ee.edge_id=e.edge_id
        JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          AND c.current_revision=s.revision
        WHERE candidate.episode_id=? AND e.rel_type IN ('supersedes','contradicts')
          AND e.status='active'
          AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
          AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?))
          AND {} AND {}
        ORDER BY e.rel_type,e.edge_id,ee.chunk_source_id
    ",
        candidate.sql, evidence.sql
    );
    let mut args = vec![
        Value::Text(episode_id.into()),
        Value::Text(relationship_at.into()),
        Value::Text(relationship_at.into()),
    ];
    args.extend(candidate.args);
    args.extend(evidence.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(args), |row| {
            Ok(RelationshipRow {
                relation: row.get(0)?,
                source_node_id: row.get(1)?,
                target_node_id: row.get(2)?,
                candidate_node_id: row.get(3)?,
                evidence_source_id: row.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn explicit_rules(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
) -> CognitionResult<HashSet<String>> {
    let validity = scope::claim(input, "e", "id");
    let source = scope::source(input, "s", "c");
    let sql = format!(
        r"
        SELECT DISTINCT m.source_id FROM memory_evidence m
        JOIN memory_nodes e ON e.id=m.node_id
        JOIN memory_chunk_sources s ON s.source_id=m.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          AND c.current_revision=s.revision
        WHERE m.episode_id=? AND e.type='constraint'
          AND (SELECT speech_act FROM memory_claims WHERE node_id=e.id)='assertion'
          AND (SELECT basis FROM memory_claims WHERE node_id=e.id)='user_statement'
          AND ((s.source_kind='conversation' AND s.role='user' AND s.origin_kind='user_input')
            OR (s.source_kind='explicit_record' AND s.role='explicit'))
          AND s.basis='user_statement' AND {} AND {}
        ORDER BY m.source_id
    ",
        validity.sql, source.sql
    );
    let mut args = vec![Value::Text(episode_id.into())];
    args.extend(validity.args);
    args.extend(source.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(args), |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)
}

pub(super) fn support_count(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
) -> CognitionResult<f64> {
    let candidate = scope::source(input, "candidate_source", "candidate_chunk");
    let evidence = scope::source(input, "s", "c");
    let sql = format!(
        r"
        SELECT COUNT(DISTINCT s.episode_id) FROM memory_evidence candidate
        JOIN memory_chunk_sources candidate_source
          ON candidate_source.source_id=candidate.source_id
        JOIN memory_chunks candidate_chunk
          ON candidate_chunk.memory_chunk_id=candidate_source.episode_id
          AND candidate_chunk.current_revision=candidate_source.revision
        JOIN edges e ON e.claim_node_id=candidate.node_id
        JOIN edge_evidence ee ON ee.edge_id=e.edge_id
        JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          AND c.current_revision=s.revision
        WHERE candidate.episode_id=? AND e.status='active'
          AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
          AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?))
          AND {} AND {}
    ",
        candidate.sql, evidence.sql
    );
    let mut args = vec![
        Value::Text(episode_id.into()),
        Value::Text(input.as_of.clone()),
        Value::Text(input.as_of.clone()),
    ];
    args.extend(candidate.args);
    args.extend(evidence.args);
    db.query_row(&sql, params_from_iter(args), |row| row.get::<_, i64>(0))
        .map(|count| count as f64)
        .map_err(db_error)
}

pub(super) fn historical_claim(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
    now_iso: &str,
    parse_date: impl Fn(&str) -> f64,
) -> CognitionResult<bool> {
    if input.time.as_ref().is_some_and(|time| {
        time.basis == RecallTimeBasis::Event && parse_date(&time.to) <= parse_date(&input.as_of)
    }) {
        return Ok(true);
    }
    if parse_date(&input.as_of) > parse_date(now_iso) {
        return Ok(false);
    }
    let mut current_input = input.clone();
    current_input.as_of = now_iso.into();
    current_input.time = None;
    let selected = scope::claim(input, "selected", "id");
    let current = scope::claim(&current_input, "selected", "id");
    let source = scope::source(input, "s", "c");
    let sql = format!(
        r"
        SELECT 1 FROM memory_evidence m
        JOIN memory_nodes selected ON selected.id=m.node_id
        JOIN memory_chunk_sources s ON s.source_id=m.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          AND c.current_revision=s.revision
        WHERE m.episode_id=?
          AND selected.type IN ('preference','goal','constraint','decision','memory_atom')
          AND {} AND NOT ({}) AND {}
        LIMIT 1
    ",
        selected.sql, current.sql, source.sql
    );
    let mut args = vec![Value::Text(episode_id.into())];
    args.extend(selected.args);
    args.extend(current.args);
    args.extend(source.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement.exists(params_from_iter(args)).map_err(db_error)
}

fn later_supersession(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
    now_iso: &str,
) -> CognitionResult<bool> {
    let event = input
        .time
        .as_ref()
        .filter(|time| time.basis == RecallTimeBasis::Event);
    let correction_input = if event.is_some() {
        input.clone()
    } else {
        let mut current = input.clone();
        current.as_of = now_iso.into();
        current.time = None;
        current
    };
    let candidate = scope::source(input, "candidate_source", "candidate_chunk");
    let correction = scope::source(&correction_input, "correction_source", "correction_chunk");
    let temporal = if event.is_some() {
        "julianday(COALESCE(e.valid_from,correction_source.observed_at))>julianday(?)
         AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(COALESCE(e.valid_from,correction_source.observed_at)))"
    } else {
        "julianday(correction_source.observed_at)>julianday(?)
         AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?))
         AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?))"
    };
    let sql = format!(
        r"
        SELECT 1 FROM memory_evidence candidate
        JOIN memory_chunk_sources candidate_source
          ON candidate_source.source_id=candidate.source_id
        JOIN memory_chunks candidate_chunk
          ON candidate_chunk.memory_chunk_id=candidate_source.episode_id
          AND candidate_chunk.current_revision=candidate_source.revision
        JOIN edges e ON e.target_node_id=candidate.node_id
          AND e.rel_type='supersedes' AND e.status='active'
        JOIN edge_evidence ee ON ee.edge_id=e.edge_id
        JOIN memory_chunk_sources correction_source
          ON correction_source.source_id=ee.chunk_source_id
        JOIN memory_chunks correction_chunk
          ON correction_chunk.memory_chunk_id=correction_source.episode_id
          AND correction_chunk.current_revision=correction_source.revision
        WHERE candidate.episode_id=? AND {} AND {} AND {temporal}
        LIMIT 1
    ",
        candidate.sql, correction.sql
    );
    let mut args = vec![Value::Text(episode_id.into())];
    args.extend(candidate.args);
    args.extend(correction.args);
    if let Some(time) = event {
        args.push(Value::Text(time.from.clone()));
    } else {
        args.extend([
            Value::Text(input.as_of.clone()),
            Value::Text(now_iso.into()),
            Value::Text(now_iso.into()),
        ]);
    }
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    statement.exists(params_from_iter(args)).map_err(db_error)
}
