use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    ConversationCode, ConversationOriginEvidence, ConversationResult, HistoricalOriginCandidate,
    SourceEvidence, evidence_error, evidence_unavailable, sha256,
};
use butler_core::json::{CanonicalKeyOrder, canonical_json};

fn open(data_root: &Path) -> rusqlite::Result<Option<Connection>> {
    let path = data_root.join("agent-runtime/btcc.sqlite");
    if !path.exists() {
        return Ok(None);
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map(Some)
}

pub(super) fn validate_outbox(
    data_root: &Path,
    started: Instant,
    cancellation: &CancellationToken,
) -> ConversationResult<()> {
    let Some(db) = open(data_root).map_err(evidence_unavailable)? else {
        return Ok(());
    };
    if !has_outbox(&db).map_err(evidence_unavailable)? {
        return Ok(());
    }
    let mut stmt = db
        .prepare("SELECT relation_id,result_id,message_id FROM btcc_subsession_outbox")
        .map_err(evidence_unavailable)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(evidence_unavailable)?;
    for row in rows {
        if cancellation.is_cancelled() || started.elapsed() >= Duration::from_secs(60) {
            return Err(evidence_error(
                ConversationCode::MemoryOriginEvidenceUnavailable,
            ));
        }
        let (relation, result, message) = row.map_err(evidence_unavailable)?;
        if message != format!("subsession-result:{relation}:{result}") {
            return Err(evidence_error(
                ConversationCode::MemoryOriginOutboxIdentityInvalid,
            ));
        }
    }
    Ok(())
}

pub(super) fn subsession_evidence(
    data_root: &Path,
    row: &HistoricalOriginCandidate,
) -> ConversationResult<Option<ConversationOriginEvidence>> {
    let (Some(external), Some(source_ref)) = (&row.external_session_id, &row.source_ref) else {
        return Ok(None);
    };
    let Some(db) = open(data_root).map_err(evidence_unavailable)? else {
        return Ok(None);
    };
    if !has_outbox(&db).map_err(evidence_unavailable)? {
        return Ok(None);
    }
    let mut stmt = db.prepare("SELECT outbox_id,relation_id,result_id,parent_session_id,message_id FROM btcc_subsession_outbox WHERE parent_session_id=?1")
        .map_err(evidence_unavailable)?;
    let rows = stmt
        .query_map([external], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(evidence_unavailable)?;
    let mut found = None;
    for item in rows {
        let (id, relation, result, parent, message) = item.map_err(evidence_unavailable)?;
        if message != format!("subsession-result:{relation}:{result}") {
            return Err(evidence_error(
                ConversationCode::MemoryOriginOutboxIdentityInvalid,
            ));
        }
        let key = format!("app:{}", subsession_client_message_id(&relation, &result));
        if key == *source_ref {
            let value = json!({"outbox_id":id,"relation_id":relation,"result_id":result,
                "parent_session_id":parent,"message_id":message});
            let bytes = canonical_json(&value, CanonicalKeyOrder::Utf16Lexical)
                .map_err(evidence_unavailable)?;
            found = Some(ConversationOriginEvidence {
                kind: "subsession".into(),
                reference: id,
                sha256: Some(sha256(bytes)),
            });
        }
    }
    Ok(found)
}

fn subsession_client_message_id(relation: &str, result: &str) -> String {
    let digest = sha256(format!(
        "butler.app.subsession-result.v1\0{relation}\0{result}"
    ));
    let part = |range: std::ops::Range<usize>| digest.get(range).unwrap_or_default();
    format!(
        "client-{}-{}-4{}-8{}-{}",
        part(0..8),
        part(8..12),
        part(13..16),
        part(17..20),
        part(20..32)
    )
}

fn has_outbox(db: &Connection) -> rusqlite::Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='btcc_subsession_outbox')", [], |r| r.get(0))
}

pub(super) fn admission(data_root: &Path, candidate: &HistoricalOriginCandidate) -> SourceEvidence {
    let (Some(external), Some(turn), Some(source_ref)) = (
        &candidate.external_session_id,
        &candidate.turn_id,
        &candidate.source_ref,
    ) else {
        return SourceEvidence::absent();
    };
    let db = match open(data_root) {
        Ok(Some(db)) => db,
        Ok(None) => return SourceEvidence::absent(),
        Err(_) => return SourceEvidence::unavailable(),
    };
    read_admission(&db, candidate, external, turn, source_ref)
        .unwrap_or_else(SourceEvidence::unavailable)
}

/// The stored admission of a turn and its inbox row.
struct TurnAdmission {
    turn_id: String,
    session: String,
    trigger: String,
    original: String,
    snapshot_ref: String,
    command_json: String,
    inbox_session: String,
    inbox_turn: String,
    inbox_trigger: String,
}

/// Admission evidence for a candidate: the turn's verified admission snapshot
/// and command must match the candidate exactly. `None` means unavailable.
fn read_admission(
    db: &Connection,
    candidate: &HistoricalOriginCandidate,
    external: &str,
    turn: &str,
    source_ref: &str,
) -> Option<SourceEvidence> {
    let Some(admission) = load_admission(db, turn)? else {
        return Some(SourceEvidence::absent());
    };
    let (record_hash, context) = verified_snapshot(db, &admission.snapshot_ref)?;
    let command: Value = serde_json::from_str(&admission.command_json).ok()?;
    let kind = command["kind"].as_str().unwrap_or_default();
    let source_id = match kind {
        "run" => command["message"]["messageId"].as_str(),
        "wake" => command["trigger"]["triggerId"].as_str(),
        _ => None,
    };
    let TurnAdmission {
        turn_id,
        session,
        trigger,
        original,
        ..
    } = &admission;
    let matched = matches!(kind, "run" | "wake")
        && session == external
        && command["sessionId"].as_str() == Some(session)
        && turn_id == turn
        && command["turnId"].as_str() == Some(turn_id)
        && admission.inbox_session == *session
        && admission.inbox_turn == *turn_id
        && admission.inbox_trigger == *trigger
        && command["triggerKey"].as_str() == Some(trigger)
        && candidate.request_id.as_deref() == Some(trigger)
        && source_ref == trigger
        && source_id == Some(original);
    if !matched {
        return Some(SourceEvidence::absent());
    }
    Some(admission_evidence(
        &command,
        &context,
        admission.snapshot_ref,
        record_hash,
    ))
}

fn load_admission(db: &Connection, turn: &str) -> Option<Option<TurnAdmission>> {
    db.query_row(
        "SELECT t.turn_id,t.session_id,t.trigger_key,t.original_message_id,t.inbox_id,t.admission_snapshot_ref,t.context_json,i.admission_input_hash,i.command_json,i.session_id,i.turn_id,i.trigger_key \
         FROM btcc_turns t JOIN btcc_inbound_inbox i ON i.inbox_id=t.inbox_id WHERE t.turn_id=?1",
        [turn],
        |r| {
            // The inbox id, context and input hash are not compared, but a
            // row missing them is not a readable admission.
            for unused in [4, 6, 7] {
                r.get::<_, String>(unused)?;
            }
            Ok(TurnAdmission {
                turn_id: r.get(0)?,
                session: r.get(1)?,
                trigger: r.get(2)?,
                original: r.get(3)?,
                snapshot_ref: r.get(5)?,
                command_json: r.get(8)?,
                inbox_session: r.get(9)?,
                inbox_turn: r.get(10)?,
                inbox_trigger: r.get(11)?,
            })
        },
    )
    .optional()
    .ok()
}

/// The admission snapshot's digest and context, when its record hashes to
/// its digest and is exactly the canonical `{"context": ..}` object.
fn verified_snapshot(db: &Connection, snapshot_ref: &str) -> Option<(String, Value)> {
    let record: Option<(String, String)> = db
        .query_row(
            "SELECT sha256,content_json FROM btcc_records WHERE record_id=?1 AND kind='admission_snapshot'",
            [snapshot_ref],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()?;
    let (record_hash, record_json) = record?;
    if sha256(record_json.as_bytes()) != record_hash {
        return None;
    }
    let snapshot: Value = serde_json::from_str(&record_json).ok()?;
    let context = snapshot.get("context")?;
    if !context.is_object()
        || canonical_json(&json!({"context":context}), CanonicalKeyOrder::Utf16Lexical).ok()?
            != record_json
    {
        return None;
    }
    Some((record_hash, context.clone()))
}

/// The matched admission's evidence: the snapshot, plus subsession, wake and
/// authority-continuation evidence; such turns are internal control.
fn admission_evidence(
    command: &Value,
    context: &Value,
    snapshot_ref: String,
    record_hash: String,
) -> SourceEvidence {
    let kind = command["kind"].as_str().unwrap_or_default();
    let role = context["executionPolicy"]["role"]
        .as_str()
        .unwrap_or_default();
    let subsession = super::truthy(&context["executionPolicy"]["subsession"])
        || super::truthy(&context["nativeStewardContext"])
        || matches!(role, "worker" | "steward");
    let authority = super::js_string(&context["authorityRequestRef"]);
    let internal = kind == "wake" || subsession || super::truthy(&context["authorityRequestRef"]);
    let mut evidence = vec![ConversationOriginEvidence {
        kind: "btcc_admission".into(),
        reference: snapshot_ref.clone(),
        sha256: Some(record_hash.clone()),
    }];
    if subsession {
        evidence.push(ConversationOriginEvidence {
            kind: "subsession".into(),
            reference: snapshot_ref,
            sha256: Some(record_hash),
        });
    }
    if kind == "wake" {
        evidence.push(ConversationOriginEvidence {
            kind: "authorized_wake".into(),
            reference: command["trigger"]["triggerId"]
                .as_str()
                .unwrap_or_default()
                .into(),
            sha256: None,
        });
    }
    if let Some(authority) = authority {
        evidence.push(ConversationOriginEvidence {
            kind: "authority_continuation".into(),
            reference: authority,
            sha256: None,
        });
    }
    SourceEvidence {
        available: true,
        matched: true,
        public_ingress: false,
        internal_control: internal,
        evidence,
    }
}
