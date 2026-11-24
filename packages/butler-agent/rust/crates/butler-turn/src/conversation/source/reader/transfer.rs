use super::{ConversationSourceReader, SourceChangeKind, SourceChangeMark, changes};
use crate::conversation::{
    ConversationError, ConversationMessageWithParts, ConversationResult, TurnOutcomeCapsule, codec,
    transfer::*, turn_outcome, turns,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashSet;

const PAGE: usize = 500;

impl ConversationSourceReader {
    pub fn session_transfer(
        &self,
        gateway: &str,
        external_session_id: &str,
    ) -> ConversationResult<Vec<TransferTurn>> {
        let db = self.connection()?;
        let tx = db
            .unchecked_transaction()
            .map_err(ConversationError::sqlite)?;
        let mut query = tx
            .prepare(
                "SELECT id FROM conversation_turns WHERE session_id=(\
             SELECT conversation_session_id FROM conversation_bindings \
             WHERE gateway=?1 AND external_session_id=?2) ORDER BY started_at",
            )
            .map_err(ConversationError::sqlite)?;
        let mut rows = query
            .query(params![gateway, external_session_id])
            .map_err(ConversationError::sqlite)?;
        let mut turns = Vec::new();
        while let Some(row) = rows.next().map_err(ConversationError::sqlite)? {
            let id: String = row.get(0).map_err(ConversationError::sqlite)?;
            if let Some(turn) = read_turn(&tx, &id)? {
                turns.push(turn);
            }
        }
        Ok(turns)
    }

    /// Export finished turns through the captured head, releasing the snapshot before each send.
    pub fn export_transfer(
        &self,
        after: Option<TransferMark>,
        mut sink: impl FnMut(TransferTurn) -> bool,
    ) -> ConversationResult<Option<TransferMark>> {
        let db = self.connection()?;
        let tx = db
            .unchecked_transaction()
            .map_err(ConversationError::sqlite)?;
        let head = changes::head(&tx)?;
        let identity = self.source_identity()?;
        let after = after
            .filter(|mark| mark.identity == identity)
            .map(|m| SourceChangeMark {
                seq: m.seq,
                key: m.key,
            });
        let ids = if let (Some(head), Some(after)) = (&head, after)
            && changes::holds(&tx, &after)?
        {
            changed_turns(&tx, after.seq, head.seq)?
        } else {
            outcome_turns(&tx)?
        };
        tx.commit().map_err(ConversationError::sqlite)?;
        for id in ids {
            let tx = db
                .unchecked_transaction()
                .map_err(ConversationError::sqlite)?;
            let turn = read_turn(&tx, &id)?;
            tx.commit().map_err(ConversationError::sqlite)?;
            if turn.is_some_and(|turn| !sink(turn)) {
                return Ok(None);
            }
        }
        let head = head.unwrap_or(SourceChangeMark {
            seq: 0,
            key: String::new(),
        });
        Ok(Some(TransferMark {
            identity,
            seq: head.seq,
            key: head.key,
        }))
    }
}

fn changed_turns(db: &Connection, mut seq: u64, head: u64) -> ConversationResult<Vec<String>> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    while seq < head {
        let page = changes::after(db, seq, PAGE)?;
        if page.is_empty() {
            break;
        }
        for change in page {
            seq = change.seq;
            if change.kind == SourceChangeKind::Turn && seen.insert(change.entity_id.clone()) {
                ids.push(change.entity_id);
            }
        }
    }
    Ok(ids)
}

fn outcome_turns(db: &Connection) -> ConversationResult<Vec<String>> {
    let mut query = db.prepare("SELECT rowid,turn_id FROM conversation_turn_outcomes WHERE rowid>?1 ORDER BY rowid LIMIT ?2")
        .map_err(ConversationError::sqlite)?;
    let mut ids = Vec::new();
    let mut rowid = 0_i64;
    loop {
        let mut rows = query
            .query(params![rowid, PAGE])
            .map_err(ConversationError::sqlite)?;
        let start = ids.len();
        while let Some(row) = rows.next().map_err(ConversationError::sqlite)? {
            rowid = row.get(0).map_err(ConversationError::sqlite)?;
            ids.push(row.get(1).map_err(ConversationError::sqlite)?);
        }
        if ids.len() - start < PAGE {
            return Ok(ids);
        }
    }
}

fn read_turn(db: &Connection, id: &str) -> ConversationResult<Option<TransferTurn>> {
    let Some(turn) = turns::get_turn(db, id)?
        .filter(|t| matches!(t.status.as_str(), "complete" | "failed" | "aborted"))
    else {
        return Ok(None);
    };
    let Some(outcome) = turn_outcome::read_outcome(db, id)? else {
        return Ok(None);
    };
    let external_session_id = db.query_row(
        "SELECT b.external_session_id FROM conversation_bindings b JOIN conversation_sessions s \
         ON b.conversation_session_id=s.id AND b.gateway=s.gateway_origin WHERE s.id=?1",
        [&turn.session_id], |r| r.get(0),
    ).optional().map_err(ConversationError::sqlite)?;
    // A session without its own binding has no identity to import under.
    let Some(external_session_id) = external_session_id else {
        return Ok(None);
    };
    let mut query = db
        .prepare(
            "SELECT * FROM conversation_messages WHERE session_id=?1 AND turn_id=?2 ORDER BY seq",
        )
        .map_err(ConversationError::sqlite)?;
    let messages = query
        .query_map(params![turn.session_id, id], codec::message_row)
        .map_err(ConversationError::sqlite)?
        .map(|m| {
            transfer_message(codec::hydrate_message(
                db,
                m.map_err(ConversationError::sqlite)?,
            )?)
        })
        .collect::<ConversationResult<_>>()?;
    Ok(Some(TransferTurn {
        session_id: turn.session_id,
        external_session_id,
        turn: TransferTurnRow {
            id: turn.id,
            actor: turn.actor,
            status: turn.status,
            request_id: turn.request_id,
            started_at: turn.started_at,
            completed_at: turn.completed_at,
        },
        messages,
        outcome: outcome.into(),
    }))
}

fn transfer_message(row: ConversationMessageWithParts) -> ConversationResult<TransferMessage> {
    let m = row.message;
    Ok(TransferMessage {
        id: m.id,
        role: m.role,
        status: m.status,
        visibility: m.visibility,
        provenance: m.provenance,
        source_gateway: m.source_gateway,
        source_ref: m.source_ref,
        origin_kind: m.origin_kind,
        origin_ref: m.origin_ref,
        origin_reason: m.origin_reason,
        origin_version: m.origin_version,
        origin_evidence: m
            .origin_evidence_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(ConversationError::json)?,
        created_at: m.created_at,
        parts: row
            .parts
            .into_iter()
            .map(|p| TransferPart {
                kind: p.kind,
                content_json: p.content_json,
                tool_call_id: p.tool_call_id,
                parent_tool_call_id: p.parent_tool_call_id,
                provider_shape: p.provider_shape,
                status: Some(p.status),
            })
            .collect(),
    })
}

impl From<TurnOutcomeCapsule> for TransferOutcome {
    fn from(o: TurnOutcomeCapsule) -> Self {
        Self {
            id: o.id,
            generation: o.generation,
            outcome: o.outcome,
            request_message_id: o.request_message_id,
            public_assistant_message_id: o.public_assistant_message_id,
            provider_id: o.provider_id,
            model_ref: o.model_ref,
            evidence_refs: o.evidence_refs,
            unresolved_obligations: o.unresolved_obligations,
            continuation: o.continuation,
            safe_code: o.safe_code,
            created_at: o.created_at,
        }
    }
}
