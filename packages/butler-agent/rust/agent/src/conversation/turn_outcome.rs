use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::codec::*;
use super::messages::referenced_hash;
use super::turns::get_turn;
use super::types::*;
use super::{
    AgentConversationStore, ConversationError, ConversationIdentityClock, ConversationResult,
};
use crate::conversation::ConversationCode;

impl AgentConversationStore {
    pub(crate) async fn read_turn_outcome(
        &self,
        turn_id: &str,
    ) -> ConversationResult<Option<TurnOutcomeCapsule>> {
        let id = turn_id.to_owned();
        self.execute(move |connection| read_outcome(connection, &id))
            .await
    }
}

pub(super) fn write_outcome(
    connection: &Connection,
    clock: &dyn ConversationIdentityClock,
    input: TurnOutcomeCapsuleInput,
) -> ConversationResult<TurnOutcomeCapsule> {
    let requested_generation = input.generation;
    let turn = get_turn(connection, &input.turn_id)?.ok_or_else(|| {
        ConversationError::new(
            ConversationCode::ConversationTurnNotFound,
            format!("Conversation turn not found: {}", input.turn_id),
        )
    })?;
    if turn.session_id != input.session_id {
        return Err(ConversationError::new(
            ConversationCode::ConversationOutcomeSessionMismatch,
            "Turn outcome session mismatch",
        ));
    }
    let referenced = referenced_hash(
        connection,
        &[
            input.request_message_id.clone(),
            input.public_assistant_message_id.clone(),
        ],
    )?;
    let mut evidence = Vec::new();
    for value in input.evidence_refs {
        if !evidence.contains(&value) {
            evidence.push(value);
        }
    }
    let mut unresolved = Vec::new();
    for value in input.unresolved_obligations {
        if !unresolved.contains(&value) {
            unresolved.push(value);
        }
    }
    let generation = if input.generation.is_nan() {
        f64::NAN
    } else {
        input.generation.trunc().max(0.0)
    };
    // Source evaluates idFactory("cto") before applying the optional input id.
    let generated_id = clock.id("cto");
    let mut capsule = TurnOutcomeCapsule {
        id: input.id.unwrap_or(generated_id),
        session_id: input.session_id,
        turn_id: input.turn_id,
        generation,
        outcome: input.outcome,
        source_hash: String::new(),
        request_message_id: input.request_message_id,
        public_assistant_message_id: input.public_assistant_message_id,
        provider_id: input.provider_id,
        model_ref: input.model_ref,
        evidence_refs: evidence,
        unresolved_obligations: unresolved,
        continuation: input.continuation,
        safe_code: input.safe_code,
        created_at: input.created_at.unwrap_or_else(|| clock.now_iso()),
    };
    capsule.source_hash = outcome_hash(&capsule, &referenced)?;
    if let Some(existing) = read_outcome(connection, &capsule.turn_id)? {
        if requested_generation < existing.generation {
            return Ok(existing);
        }
        if requested_generation == existing.generation {
            if capsule.source_hash != existing.source_hash {
                return Err(ConversationError::new(
                    ConversationCode::ConversationOutcomeGenerationConflict,
                    format!(
                        "Turn outcome generation conflict: {}:{}",
                        capsule.turn_id, capsule.generation
                    ),
                ));
            }
            return Ok(existing);
        }
    }
    let evidence_json =
        stringify(&serde_json::to_value(&capsule.evidence_refs).map_err(ConversationError::json)?)?;
    let unresolved_json = stringify(
        &serde_json::to_value(&capsule.unresolved_obligations).map_err(ConversationError::json)?,
    )?;
    let continuation_json = capsule
        .continuation
        .as_ref()
        .map(|value| stringify(&Value::Object(value.clone())))
        .transpose()?;
    connection
        .execute(
            "INSERT INTO conversation_turn_outcomes \
         (id,session_id,turn_id,generation,outcome,source_hash,request_message_id,\
         public_assistant_message_id,provider_id,model_ref,evidence_refs_json,\
         unresolved_obligations_json,continuation_json,safe_code,created_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) \
         ON CONFLICT(turn_id) DO UPDATE SET id=excluded.id,generation=excluded.generation,\
         outcome=excluded.outcome,source_hash=excluded.source_hash,\
         request_message_id=excluded.request_message_id,\
         public_assistant_message_id=excluded.public_assistant_message_id,\
         provider_id=excluded.provider_id,model_ref=excluded.model_ref,\
         evidence_refs_json=excluded.evidence_refs_json,\
         unresolved_obligations_json=excluded.unresolved_obligations_json,\
         continuation_json=excluded.continuation_json,safe_code=excluded.safe_code,\
         created_at=excluded.created_at",
            params![
                capsule.id,
                capsule.session_id,
                capsule.turn_id,
                capsule.generation,
                outcome_text(capsule.outcome),
                capsule.source_hash,
                capsule.request_message_id,
                capsule.public_assistant_message_id,
                capsule.provider_id,
                capsule.model_ref,
                evidence_json,
                unresolved_json,
                continuation_json,
                capsule.safe_code,
                capsule.created_at
            ],
        )
        .map_err(ConversationError::sqlite)?;
    bump_public_revision(connection)?;
    enqueue(
        connection,
        clock,
        &capsule.session_id,
        turn.seq as f64,
        "conversation.turn_outcome_written",
        &capsule.id,
        &capsule.created_at,
    )?;
    Ok(capsule)
}

pub(super) fn read_outcome(
    connection: &Connection,
    turn_id: &str,
) -> ConversationResult<Option<TurnOutcomeCapsule>> {
    let raw = connection
        .query_row(
            "SELECT * FROM conversation_turn_outcomes WHERE turn_id=?1",
            [turn_id],
            |row| {
                Ok((
                    row.get::<_, String>("id")?,
                    row.get::<_, String>("session_id")?,
                    row.get::<_, String>("turn_id")?,
                    row.get::<_, f64>("generation")?,
                    row.get::<_, String>("outcome")?,
                    row.get::<_, String>("source_hash")?,
                    row.get::<_, Option<String>>("request_message_id")?,
                    row.get::<_, Option<String>>("public_assistant_message_id")?,
                    row.get::<_, Option<String>>("provider_id")?,
                    row.get::<_, Option<String>>("model_ref")?,
                    row.get::<_, String>("evidence_refs_json")?,
                    row.get::<_, String>("unresolved_obligations_json")?,
                    row.get::<_, Option<String>>("continuation_json")?,
                    row.get::<_, Option<String>>("safe_code")?,
                    row.get::<_, String>("created_at")?,
                ))
            },
        )
        .optional()
        .map_err(ConversationError::sqlite)?;
    let Some(row) = raw else { return Ok(None) };
    let capsule = TurnOutcomeCapsule {
        id: row.0,
        session_id: row.1,
        turn_id: row.2,
        generation: row.3,
        outcome: outcome(&row.4)?,
        source_hash: row.5,
        request_message_id: row.6,
        public_assistant_message_id: row.7,
        provider_id: row.8,
        model_ref: row.9,
        evidence_refs: serde_json::from_str(&row.10).map_err(ConversationError::json)?,
        unresolved_obligations: serde_json::from_str(&row.11).map_err(ConversationError::json)?,
        continuation: row
            .12
            .map(|v| serde_json::from_str(&v).map_err(ConversationError::json))
            .transpose()?,
        safe_code: row.13,
        created_at: row.14,
    };
    let referenced = referenced_hash(
        connection,
        &[
            capsule.request_message_id.clone(),
            capsule.public_assistant_message_id.clone(),
        ],
    )?;
    if outcome_hash(&capsule, &referenced)? == capsule.source_hash {
        Ok(Some(capsule))
    } else {
        Ok(None)
    }
}

fn outcome_hash(capsule: &TurnOutcomeCapsule, referenced: &str) -> ConversationResult<String> {
    let mut object = Map::new();
    object.insert("session_id".into(), capsule.session_id.clone().into());
    object.insert("turn_id".into(), capsule.turn_id.clone().into());
    object.insert(
        "generation".into(),
        serde_json::Number::from_f64(capsule.generation)
            .map(Value::Number)
            .unwrap_or(Value::Null),
    );
    object.insert("outcome".into(), outcome_text(capsule.outcome).into());
    for (key, value) in [
        ("request_message_id", capsule.request_message_id.as_ref()),
        (
            "public_assistant_message_id",
            capsule.public_assistant_message_id.as_ref(),
        ),
        ("provider_id", capsule.provider_id.as_ref()),
        ("model_ref", capsule.model_ref.as_ref()),
    ] {
        object.insert(
            key.into(),
            value.cloned().map(Value::String).unwrap_or(Value::Null),
        );
    }
    object.insert(
        "evidence_refs".into(),
        serde_json::to_value(&capsule.evidence_refs).map_err(ConversationError::json)?,
    );
    object.insert(
        "unresolved_obligations".into(),
        serde_json::to_value(&capsule.unresolved_obligations).map_err(ConversationError::json)?,
    );
    object.insert(
        "continuation".into(),
        capsule
            .continuation
            .clone()
            .map(Value::Object)
            .unwrap_or(Value::Null),
    );
    object.insert(
        "safe_code".into(),
        capsule
            .safe_code
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    object.insert("referenced_messages_hash".into(), referenced.into());
    let mut hash = Sha256::new();
    hash.update(stringify(&Value::Object(object))?.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}
