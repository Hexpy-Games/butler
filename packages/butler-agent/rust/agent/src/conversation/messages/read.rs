use rusqlite::{Connection, OptionalExtension, params_from_iter};

use crate::conversation::codec::*;
use crate::conversation::types::*;
use crate::conversation::{AgentConversationStore, ConversationError, ConversationResult};

impl AgentConversationStore {
    pub(crate) async fn read_message_by_id(
        &self,
        id: &str,
    ) -> ConversationResult<Option<ConversationMessageWithParts>> {
        let id = id.to_owned();
        self.execute(move |connection| read_message(connection, &id))
            .await
    }

    pub(crate) async fn read_message_by_source_ref(
        &self,
        session_id: &str,
        source_ref: &str,
    ) -> ConversationResult<Option<ConversationMessageWithParts>> {
        let session_id = session_id.to_owned();
        let source_ref = crate::public_text::trim_js_whitespace(source_ref).to_owned();
        if source_ref.is_empty() {
            return Ok(None);
        }
        self.execute(move |connection| {
            read_one(
                connection,
                "WHERE session_id=?1 AND source_ref=?2 ORDER BY seq ASC",
                &[&session_id, &source_ref],
            )
        })
        .await
    }

    pub(crate) async fn read_messages(
        &self,
        input: ReadMessagesInput,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        self.execute(move |connection| read_many(connection, input))
            .await
    }

    /// Scan source's first 5,000 ordered messages while retaining only IDs and match bits.
    /// Selection and hydration run in the same SQLite lane operation.
    pub(crate) async fn read_context_query_selected<P, S>(
        &self,
        session_id: String,
        predicate: P,
        select: S,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>>
    where
        P: Fn(&ConversationMessageWithParts) -> bool + Send + 'static,
        S: FnOnce(&[(String, bool)]) -> Vec<String> + Send + 'static,
    {
        self.execute(move |connection| {
            let ids = {
                let mut statement = connection
                    .prepare(
                        "SELECT id FROM conversation_messages WHERE session_id=?1 \
                     AND compacted_by_summary_id IS NULL AND status!='compacted' \
                     ORDER BY seq ASC LIMIT 5000",
                    )
                    .map_err(ConversationError::sqlite)?;
                statement
                    .query_map([session_id], |row| row.get::<_, String>(0))
                    .map_err(ConversationError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(ConversationError::sqlite)?
            };
            let mut matches = Vec::with_capacity(ids.len());
            for id in ids {
                let matched = read_message(connection, &id)?
                    .as_ref()
                    .is_some_and(&predicate);
                matches.push((id, matched));
            }
            select(&matches)
                .into_iter()
                .map(|id| read_message(connection, &id))
                .collect::<ConversationResult<Vec<_>>>()
                .map(|messages| messages.into_iter().flatten().collect())
        })
        .await
    }

    pub(crate) async fn read_cognition_messages(
        &self,
        input: ReadCognitionMessagesInput,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        self.execute(move |connection| cognition(connection, input))
            .await
    }

    pub(crate) async fn read_projection_message_page(
        &self,
        session_id: &str,
        after_seq: Option<u64>,
        before_seq: Option<u64>,
        limit: usize,
    ) -> ConversationResult<ConversationMessagePage> {
        let session_id = session_id.to_owned();
        let limit = limit.clamp(1, 200) as u64;
        self.execute(move |connection| {
            let query_limit = limit + 1;
            let (sql, cursor) = if let Some(before) = before_seq {
                (
                    "SELECT * FROM conversation_messages WHERE session_id=?1 AND seq<?2 AND role IN ('user','assistant') AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq DESC LIMIT ?3",
                    before,
                )
            } else if let Some(after) = after_seq {
                (
                    "SELECT * FROM conversation_messages WHERE session_id=?1 AND seq>?2 AND role IN ('user','assistant') AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq ASC LIMIT ?3",
                    after,
                )
            } else {
                (
                    "SELECT * FROM conversation_messages WHERE session_id=?1 AND seq>?2 AND role IN ('user','assistant') AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq DESC LIMIT ?3",
                    0,
                )
            };
            let mut messages = query_messages(
                connection,
                sql,
                [
                    rusqlite::types::Value::Text(session_id),
                    sql_integer(cursor),
                    sql_integer(query_limit),
                ],
            )?;
            let has_more = messages.len() > limit as usize;
            messages.truncate(limit as usize);
            if before_seq.is_some() || (after_seq.is_none() && before_seq.is_none()) {
                messages.reverse();
            }
            Ok(ConversationMessagePage { messages, has_more })
        })
        .await
    }

    pub(crate) async fn read_messages_around(
        &self,
        input: ReadAroundInput,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        self.execute(move |connection| around(connection, input))
            .await
    }

    pub(crate) async fn conversation_messages_source_hash(
        &self,
        ids: Vec<String>,
    ) -> ConversationResult<String> {
        self.execute(move |connection| {
            let mut source = SourceHasher::new();
            for id in ids {
                if let Some(message) = read_message(connection, &id)? {
                    source.push(&message)?;
                }
            }
            Ok(source.finish())
        })
        .await
    }
}

pub(in crate::conversation) fn projection(
    connection: &Connection,
    session_id: &str,
    after_seq: Option<f64>,
    limit: Option<f64>,
) -> ConversationResult<Vec<ConversationMessageWithParts>> {
    let after = after_seq
        .filter(|value| value.is_finite())
        .map(|value| value.floor().max(0.0) as u64)
        .unwrap_or(0);
    let limit = normalize_limit(limit, 500, 1000);
    query_messages(
        connection,
        "SELECT * FROM conversation_messages WHERE session_id=?1 AND seq>?2 AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq ASC LIMIT ?3",
        [
            rusqlite::types::Value::Text(session_id.into()),
            sql_integer(after),
            sql_integer(limit),
        ],
    )
}

fn read_one(
    connection: &Connection,
    suffix: &str,
    values: &[&str],
) -> ConversationResult<Option<ConversationMessageWithParts>> {
    let sql = format!("SELECT * FROM conversation_messages {suffix} LIMIT 1");
    let message = connection
        .query_row(&sql, params_from_iter(values.iter()), message_row)
        .optional()
        .map_err(ConversationError::sqlite)?;
    message
        .map(|message| hydrate_message(connection, message))
        .transpose()
}

fn query_messages<I>(
    connection: &Connection,
    sql: &str,
    values: I,
) -> ConversationResult<Vec<ConversationMessageWithParts>>
where
    I: IntoIterator<Item = rusqlite::types::Value>,
{
    let mut statement = connection.prepare(sql).map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map(params_from_iter(values), message_row)
        .map_err(ConversationError::sqlite)?;
    let mut output = Vec::new();
    for row in rows {
        output.push(hydrate_message(
            connection,
            row.map_err(ConversationError::sqlite)?,
        )?);
    }
    Ok(output)
}

fn read_many(
    connection: &Connection,
    input: ReadMessagesInput,
) -> ConversationResult<Vec<ConversationMessageWithParts>> {
    let limit = normalize_limit(input.limit, 500, 5000);
    let sql = if input.include_compacted {
        "SELECT * FROM conversation_messages WHERE session_id=?1 ORDER BY seq ASC LIMIT ?2"
    } else {
        "SELECT * FROM conversation_messages WHERE session_id=?1 AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq ASC LIMIT ?2"
    };
    query_messages(
        connection,
        sql,
        [
            rusqlite::types::Value::Text(input.session_id),
            sql_integer(limit),
        ],
    )
}

pub(in crate::conversation) fn cognition(
    connection: &Connection,
    input: ReadCognitionMessagesInput,
) -> ConversationResult<Vec<ConversationMessageWithParts>> {
    let limit = normalize_limit(input.limit, 1000, 5000);
    let offset = input
        .offset
        .filter(|v| v.is_finite())
        .map(|v| v.floor().max(0.0) as u64)
        .unwrap_or(0);
    let mut clauses = vec!["visibility='model'".to_owned()];
    let mut values = Vec::new();
    if let Some(session) = input
        .session_id
        .map(|v| crate::public_text::trim_js_whitespace(&v).to_owned())
        .filter(|v| !v.is_empty())
    {
        values.push(rusqlite::types::Value::Text(session));
        clauses.push(format!("session_id=?{}", values.len()));
    }
    if !input.roles.is_empty() {
        let mut roles = Vec::new();
        for role in input.roles {
            let text = role_text(role).to_owned();
            if !roles.contains(&text) {
                roles.push(text);
            }
        }
        let mut slots = Vec::new();
        for role in roles {
            values.push(rusqlite::types::Value::Text(role));
            slots.push(format!("?{}", values.len()));
        }
        clauses.push(format!("role IN ({})", slots.join(",")));
    }
    if let Some(since) = input
        .since
        .map(|v| crate::public_text::trim_js_whitespace(&v).to_owned())
        .filter(|v| !v.is_empty())
    {
        values.push(rusqlite::types::Value::Text(since));
        clauses.push(format!("created_at>=?{}", values.len()));
    }
    if !input.include_compacted {
        clauses.push("compacted_by_summary_id IS NULL".into());
        clauses.push("status!='compacted'".into());
    }
    values.push(sql_integer(limit));
    let limit_slot = values.len();
    values.push(sql_integer(offset));
    let offset_slot = values.len();
    let order = if input.order == Some(ConversationReadOrder::Desc) {
        "DESC"
    } else {
        "ASC"
    };
    let sql = format!(
        "SELECT * FROM conversation_messages WHERE {} ORDER BY created_at {order},seq {order},id {order} LIMIT ?{limit_slot} OFFSET ?{offset_slot}",
        clauses.join(" AND ")
    );
    query_messages(connection, &sql, values)
}

pub(in crate::conversation) fn semantic_tail(
    connection: &Connection,
    session_id: &str,
    limit: Option<u64>,
) -> ConversationResult<Vec<ConversationMessageWithParts>> {
    match limit {
        Some(limit) => {
            let mut rows = query_messages(
                connection,
                "SELECT * FROM conversation_messages WHERE session_id=?1 AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq DESC LIMIT ?2",
                [
                    rusqlite::types::Value::Text(session_id.into()),
                    sql_integer(limit),
                ],
            )?;
            rows.reverse();
            Ok(rows)
        }
        None => query_messages(
            connection,
            "SELECT * FROM conversation_messages WHERE session_id=?1 AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq ASC",
            [rusqlite::types::Value::Text(session_id.into())],
        ),
    }
}

pub(in crate::conversation) fn around(
    connection: &Connection,
    input: ReadAroundInput,
) -> ConversationResult<Vec<ConversationMessageWithParts>> {
    let limit = normalize_limit(input.limit, 10, 80);
    let anchor = input
        .anchor_message_id
        .as_deref()
        .map(|id| {
            connection
                .query_row(
                    "SELECT seq FROM conversation_messages WHERE id=?1",
                    [id],
                    |row| row.get::<_, u64>(0),
                )
                .optional()
                .map_err(ConversationError::sqlite)
        })
        .transpose()?
        .flatten();
    let max: Option<u64> = connection
        .query_row(
            "SELECT MAX(seq) FROM conversation_messages WHERE session_id=?1",
            [&input.session_id],
            |row| row.get(0),
        )
        .map_err(ConversationError::sqlite)?;
    let anchor = anchor.unwrap_or(max.unwrap_or(0));
    let (direction_start, direction_end) = match input.direction.as_deref() {
        Some("before") => (anchor.saturating_sub(limit - 1).max(1), anchor),
        Some("after") => (anchor, anchor + limit - 1),
        _ => (
            anchor.saturating_sub((limit - 1) / 2).max(1),
            anchor + limit - (limit - 1) / 2 - 1,
        ),
    };
    let sql = if input.include_compacted {
        "SELECT * FROM conversation_messages WHERE session_id=?1 AND seq BETWEEN ?2 AND ?3 ORDER BY seq ASC LIMIT ?4"
    } else {
        "SELECT * FROM conversation_messages WHERE session_id=?1 AND seq BETWEEN ?2 AND ?3 AND compacted_by_summary_id IS NULL AND status!='compacted' ORDER BY seq ASC LIMIT ?4"
    };
    query_messages(
        connection,
        sql,
        [
            rusqlite::types::Value::Text(input.session_id),
            sql_integer(direction_start),
            sql_integer(direction_end),
            sql_integer(limit),
        ],
    )
}

fn sql_integer(value: u64) -> rusqlite::types::Value {
    rusqlite::types::Value::Integer(value as i64)
}

pub(in crate::conversation) fn referenced_hash(
    connection: &Connection,
    ids: &[Option<String>],
) -> ConversationResult<String> {
    let mut messages = Vec::new();
    for id in ids.iter().flatten() {
        if let Some(message) = read_message(connection, id)? {
            messages.push(message);
        }
    }
    source_hash(&messages)
}
