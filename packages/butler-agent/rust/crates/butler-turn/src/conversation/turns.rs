use rusqlite::{Connection, OptionalExtension, params};

use super::codec::*;
use super::turn_outcome::write_outcome;
use super::types::*;
use super::{
    AgentConversationStore, ConversationError, ConversationIdentityClock, ConversationResult,
};
use crate::conversation::ConversationCode;

impl AgentConversationStore {
    /// Begins (or replays) a turn.
    pub async fn begin_turn(&self, input: BeginTurnInput) -> ConversationResult<ConversationTurn> {
        let clock = self.identity_clock().clone();
        let now = input.now.clone().unwrap_or_else(|| clock.now_iso());
        let session_id = input.session_id.clone().unwrap_or_else(|| clock.id("cs"));
        let turn_id = input.turn_id.clone().unwrap_or_else(|| clock.id("ct"));
        self.execute(move |connection| {
            begin(
                connection,
                clock.as_ref(),
                input,
                &session_id,
                turn_id,
                &now,
            )
        })
        .await
    }
    /// Finalizes a turn.
    pub async fn finalize_turn(
        &self,
        input: FinalizeTurnInput,
    ) -> ConversationResult<ConversationTurn> {
        let clock = self.identity_clock().clone();
        let completed = input
            .completed_at
            .clone()
            .unwrap_or_else(|| clock.now_iso());
        self.execute(move |connection| finalize(connection, clock.as_ref(), input, &completed))
            .await
    }
    /// Batched lifecycle facts for graph nodes, keyed by exact turn identity.
    pub async fn read_turn_lifecycles(
        &self,
        ids: Vec<String>,
    ) -> ConversationResult<serde_json::Value> {
        let ids = serde_json::json!(ids).to_string();
        self.execute(move |db| {
            let mut result = serde_json::Map::new();
            let mut query = db.prepare_cached("SELECT t.id,t.started_at,t.completed_at,t.status FROM json_each(?1) ids JOIN conversation_turns t ON t.id=ids.value").map_err(ConversationError::sqlite)?;
            let rows = query.query_map([ids], |r| Ok((r.get::<_,String>(0)?,serde_json::json!({"started_at":r.get::<_,String>(1)?,"finished_at":r.get::<_,Option<String>>(2)?,"status":r.get::<_,String>(3)?})))) .map_err(ConversationError::sqlite)?;
            for row in rows { let (id,value)=row.map_err(ConversationError::sqlite)?;result.insert(id,value); }
            Ok(serde_json::Value::Object(result))
        }).await
    }
    /// A turn by id.
    pub async fn read_turn(&self, id: &str) -> ConversationResult<Option<ConversationTurn>> {
        let id = id.to_owned();
        self.execute(move |connection| get_turn(connection, &id))
            .await
    }
}

fn begin(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
    input: BeginTurnInput,
    session_id: &str,
    turn_id: String,
    now: &str,
) -> ConversationResult<ConversationTurn> {
    let tx = connection
        .transaction()
        .map_err(ConversationError::sqlite)?;
    let turn = begin_in_transaction(&tx, clock, input, session_id, turn_id, now)?;
    tx.commit().map_err(ConversationError::sqlite)?;
    Ok(turn)
}

pub(super) fn begin_in_transaction(
    tx: &Connection,
    clock: &dyn ConversationIdentityClock,
    input: BeginTurnInput,
    session_id: &str,
    turn_id: String,
    now: &str,
) -> ConversationResult<ConversationTurn> {
    if let Some(turn) = get_turn(tx, &turn_id)? {
        return Ok(turn);
    }
    bind_session(tx, clock, &input, session_id, now)?;
    let turn = ConversationTurn {
        id: turn_id,
        session_id: session_id.to_string(),
        seq: next_seq(tx, "conversation_turns", session_id)?,
        actor: input.actor,
        status: "running".into(),
        request_id: input.request_id,
        started_at: now.to_string(),
        completed_at: None,
    };
    tx.execute(
        "INSERT INTO conversation_turns \
         (id,session_id,seq,actor,status,request_id,started_at,completed_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,NULL)",
        params![
            turn.id,
            turn.session_id,
            turn.seq,
            turn.actor,
            turn.status,
            turn.request_id,
            turn.started_at
        ],
    )
    .map_err(ConversationError::sqlite)?;
    enqueue(
        tx,
        clock,
        session_id,
        turn.seq as f64,
        "conversation.turn_started",
        &turn.id,
        now,
    )?;
    Ok(turn)
}

/// Upserts the active session and its gateway binding and publishes
/// `conversation.session_bound`; a project or status change bumps the
/// public revision.
fn bind_session(
    tx: &Connection,
    clock: &dyn ConversationIdentityClock,
    input: &BeginTurnInput,
    session_id: &str,
    now: &str,
) -> ConversationResult<()> {
    let before = tx
        .query_row(
            "SELECT project_id,status FROM conversation_sessions WHERE id=?1",
            [&session_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(ConversationError::sqlite)?;
    tx.execute(
        "INSERT INTO conversation_sessions \
         (id,workspace_id,project_id,gateway_origin,created_at,updated_at,status,schema_version) \
         VALUES (?1,?2,?3,?4,?5,?5,'active',?6) ON CONFLICT(id) DO UPDATE SET \
         workspace_id=excluded.workspace_id,project_id=excluded.project_id,\
         gateway_origin=excluded.gateway_origin,updated_at=excluded.updated_at,\
         status=excluded.status,schema_version=excluded.schema_version",
        params![
            session_id,
            input.workspace_id,
            input.project_id,
            input.gateway,
            now,
            super::schema::VERSION
        ],
    )
    .map_err(ConversationError::sqlite)?;
    if before.is_some_and(|v| v.0 != input.project_id || v.1 != "active") {
        bump_public_revision(tx)?;
    }
    tx.execute(
        "INSERT INTO conversation_bindings \
         (gateway,external_session_id,conversation_session_id,created_at) VALUES (?1,?2,?3,?4) \
         ON CONFLICT(gateway,external_session_id) DO UPDATE SET \
         conversation_session_id=excluded.conversation_session_id",
        params![input.gateway, input.external_session_id, session_id, now],
    )
    .map_err(ConversationError::sqlite)?;
    enqueue(
        tx,
        clock,
        session_id,
        0.0,
        "conversation.session_bound",
        session_id,
        now,
    )
}

fn finalize(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
    input: FinalizeTurnInput,
    completed: &str,
) -> ConversationResult<ConversationTurn> {
    let tx = connection
        .transaction()
        .map_err(ConversationError::sqlite)?;
    let turn = finalize_in_transaction(&tx, clock, input, completed)?;
    tx.commit().map_err(ConversationError::sqlite)?;
    Ok(turn)
}

pub(super) fn finalize_in_transaction(
    tx: &Connection,
    clock: &dyn ConversationIdentityClock,
    input: FinalizeTurnInput,
    completed: &str,
) -> ConversationResult<ConversationTurn> {
    get_turn(tx, &input.turn_id)?.ok_or_else(|| {
        ConversationError::new(
            ConversationCode::ConversationTurnNotFound,
            format!("Conversation turn not found: {}", input.turn_id),
        )
    })?;
    if let Some(outcome) = input.outcome_capsule {
        write_outcome(tx, clock, outcome)?;
    }
    tx.execute(
        "UPDATE conversation_turns SET status=?1,completed_at=?2 WHERE id=?3",
        params![
            input.status.unwrap_or_else(|| "complete".into()),
            completed,
            input.turn_id
        ],
    )
    .map_err(ConversationError::sqlite)?;
    let turn = get_turn(tx, &input.turn_id)?.ok_or_else(|| {
        ConversationError::new(
            ConversationCode::ConversationTurnNotFound,
            "Conversation turn disappeared",
        )
    })?;
    Ok(turn)
}

pub(super) fn get_turn(
    connection: &Connection,
    id: &str,
) -> ConversationResult<Option<ConversationTurn>> {
    connection
        .query_row(
            "SELECT * FROM conversation_turns WHERE id=?1",
            [id],
            |row| {
                Ok(ConversationTurn {
                    id: row.get("id")?,
                    session_id: row.get("session_id")?,
                    seq: row.get("seq")?,
                    actor: row.get("actor")?,
                    status: row.get("status")?,
                    request_id: row.get("request_id")?,
                    started_at: row.get("started_at")?,
                    completed_at: row.get("completed_at")?,
                })
            },
        )
        .optional()
        .map_err(ConversationError::sqlite)
}
