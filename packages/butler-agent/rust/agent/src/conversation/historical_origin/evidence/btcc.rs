use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{ConversationOriginEvidence, HistoricalOriginCandidate, SourceEvidence, sha256};
use crate::json::{CanonicalKeyOrder, canonical_json};

fn open(data_root: &Path) -> Result<Option<Connection>, ()> {
    let path = data_root.join("agent-runtime/btcc.sqlite");
    if !path.exists() {
        return Ok(None);
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map(Some)
        .map_err(|_| ())
}

pub(super) fn validate_outbox(
    data_root: &Path,
    started: Instant,
    cancellation: &CancellationToken,
) -> Result<(), &'static str> {
    let Some(db) = open(data_root).map_err(|_| "memory_origin_evidence_unavailable")? else {
        return Ok(());
    };
    if !has_outbox(&db).map_err(|_| "memory_origin_evidence_unavailable")? {
        return Ok(());
    }
    let mut stmt = db
        .prepare("SELECT relation_id,result_id,message_id FROM btcc_subsession_outbox")
        .map_err(|_| "memory_origin_evidence_unavailable")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "memory_origin_evidence_unavailable")?;
    for row in rows {
        if cancellation.is_cancelled() || started.elapsed() >= Duration::from_secs(60) {
            return Err("memory_origin_evidence_unavailable");
        }
        let (relation, result, message) = row.map_err(|_| "memory_origin_evidence_unavailable")?;
        if message != format!("subsession-result:{relation}:{result}") {
            return Err("memory_origin_outbox_identity_invalid");
        }
    }
    Ok(())
}

pub(super) fn subsession_evidence(
    data_root: &Path,
    row: &HistoricalOriginCandidate,
) -> Result<Option<ConversationOriginEvidence>, &'static str> {
    let (Some(external), Some(source_ref)) = (&row.external_session_id, &row.source_ref) else {
        return Ok(None);
    };
    let Some(db) = open(data_root).map_err(|_| "memory_origin_evidence_unavailable")? else {
        return Ok(None);
    };
    if !has_outbox(&db).map_err(|_| "memory_origin_evidence_unavailable")? {
        return Ok(None);
    }
    let mut stmt = db.prepare("SELECT outbox_id,relation_id,result_id,parent_session_id,message_id FROM btcc_subsession_outbox WHERE parent_session_id=?1")
        .map_err(|_| "memory_origin_evidence_unavailable")?;
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
        .map_err(|_| "memory_origin_evidence_unavailable")?;
    let mut found = None;
    for item in rows {
        let (id, relation, result, parent, message) =
            item.map_err(|_| "memory_origin_evidence_unavailable")?;
        if message != format!("subsession-result:{relation}:{result}") {
            return Err("memory_origin_outbox_identity_invalid");
        }
        let key = format!("app:{}", subsession_client_message_id(&relation, &result));
        if key == *source_ref {
            let value = json!({"outbox_id":id,"relation_id":relation,"result_id":result,
                "parent_session_id":parent,"message_id":message});
            let bytes = canonical_json(&value, CanonicalKeyOrder::Utf16Lexical)
                .map_err(|_| "memory_origin_evidence_unavailable")?;
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
    format!(
        "client-{}-{}-4{}-8{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
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
        Err(()) => return SourceEvidence::unavailable(),
    };
    read_admission(&db, candidate, external, turn, source_ref)
        .unwrap_or_else(|_| SourceEvidence::unavailable())
}

fn read_admission(
    db: &Connection,
    candidate: &HistoricalOriginCandidate,
    external: &str,
    turn: &str,
    source_ref: &str,
) -> Result<SourceEvidence, ()> {
    type TurnRow = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    );
    let row: Option<TurnRow> = db.query_row(
        "SELECT t.turn_id,t.session_id,t.trigger_key,t.original_message_id,t.inbox_id,t.admission_snapshot_ref,t.context_json,i.admission_input_hash,i.command_json,i.session_id,i.turn_id,i.trigger_key \
         FROM btcc_turns t JOIN btcc_inbound_inbox i ON i.inbox_id=t.inbox_id WHERE t.turn_id=?1", [turn],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?)),
    ).optional().map_err(|_| ())?;
    let Some((
        turn_id,
        session,
        trigger,
        original,
        _inbox,
        snapshot_ref,
        _context,
        _input_hash,
        command_json,
        inbox_session,
        inbox_turn,
        inbox_trigger,
    )) = row
    else {
        return Ok(SourceEvidence::absent());
    };
    let record: Option<(String,String)> = db.query_row(
        "SELECT sha256,content_json FROM btcc_records WHERE record_id=?1 AND kind='admission_snapshot'", [&snapshot_ref],
        |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(|_| ())?;
    let Some((record_hash, record_json)) = record else {
        return Err(());
    };
    if sha256(record_json.as_bytes()) != record_hash {
        return Err(());
    }
    let command: Value = serde_json::from_str(&command_json).map_err(|_| ())?;
    let snapshot: Value = serde_json::from_str(&record_json).map_err(|_| ())?;
    let context = &snapshot["context"];
    if !context.is_object()
        || canonical_json(&json!({"context":context}), CanonicalKeyOrder::Utf16Lexical)
            .map_err(|_| ())?
            != record_json
    {
        return Err(());
    }
    let kind = command["kind"].as_str().unwrap_or_default();
    let source_id = if kind == "run" {
        command["message"]["messageId"].as_str()
    } else if kind == "wake" {
        command["trigger"]["triggerId"].as_str()
    } else {
        None
    };
    let matched = matches!(kind, "run" | "wake")
        && session == external
        && command["sessionId"].as_str() == Some(&session)
        && turn_id == turn
        && command["turnId"].as_str() == Some(&turn_id)
        && inbox_session == session
        && inbox_turn == turn_id
        && inbox_trigger == trigger
        && command["triggerKey"].as_str() == Some(&trigger)
        && candidate.request_id.as_deref() == Some(&trigger)
        && source_ref == trigger
        && source_id == Some(&original);
    if !matched {
        return Ok(SourceEvidence::absent());
    }
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
            reference: snapshot_ref.clone(),
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
    Ok(SourceEvidence {
        available: true,
        matched: true,
        public_ingress: false,
        internal_control: internal,
        evidence,
    })
}
