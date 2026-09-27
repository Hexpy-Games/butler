use rusqlite::{params, params_from_iter, types::Value};

use super::{PublicMemoryScope, PublicMemorySnapshot};
use crate::conversation::{ConversationError, ConversationMessageWithParts, ConversationResult};

/// Whether a session page includes archived sessions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Archived {
    Include,
    Exclude,
}

/// Whether previews include internal (non user/public-assistant) messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageOrigins {
    PublicOnly,
    IncludeInternal,
}

/// A session as public memory lists it.
#[derive(Clone, Debug)]
pub struct PublicSessionRow {
    pub id: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub gateway_origin: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u64,
    pub last_eligible_message_at: String,
}

impl PublicMemorySnapshot {
    /// A page of sessions in scope.
    pub fn session_page(
        &self,
        scope: &PublicMemoryScope,
        archived: Archived,
        time: Option<(&str, &str)>,
        after: Option<(&str, &str)>,
        limit: usize,
    ) -> ConversationResult<Vec<PublicSessionRow>> {
        let mut sql = String::from(
            "SELECT s.id,s.workspace_id,s.project_id,s.gateway_origin,s.status,s.created_at,s.updated_at,\
             COUNT(DISTINCT m.id),MAX(m.created_at) FROM conversation_sessions s \
             JOIN conversation_messages m ON m.session_id=s.id \
             WHERE m.visibility='model' AND m.status IN ('complete','compacted') \
             AND m.role IN ('user','assistant') AND s.status!='deleted'",
        );
        let mut values: Vec<Value> = Vec::new();
        if !scope.include_internal {
            sql.push_str(" AND m.origin_kind IN ('user_input','assistant_public')");
        }
        if scope.kind == "current_session" {
            sql.push_str(" AND m.session_id=?");
            values.push(scope.current_session_id.clone().into());
        }
        if scope.kind == "current_project" {
            sql.push_str(" AND s.project_id=?");
            values.push(scope.current_project_id.clone().unwrap_or_default().into());
        }
        if !scope.session_ids.is_empty() {
            append_in(&mut sql, "m.session_id", &scope.session_ids, &mut values);
        }
        match scope.project_filter.as_str() {
            "unassigned" => sql.push_str(" AND s.project_id IS NULL"),
            "selected" => append_in(&mut sql, "s.project_id", &scope.project_ids, &mut values),
            _ => {}
        }
        if archived == Archived::Exclude {
            sql.push_str(" AND s.status!='archived'");
        }
        if let Some((from, to)) = time {
            sql.push_str(" AND m.created_at >= ? AND m.created_at < ?");
            values.extend([from.to_owned().into(), to.to_owned().into()]);
        }
        sql.push_str(" GROUP BY s.id");
        if let Some((at, id)) = after {
            sql.push_str(" HAVING MAX(m.created_at) < ? OR (MAX(m.created_at)=? AND s.id>?)");
            values.extend([
                at.to_owned().into(),
                at.to_owned().into(),
                id.to_owned().into(),
            ]);
        }
        sql.push_str(" ORDER BY MAX(m.created_at) DESC,s.id ASC LIMIT ?");
        values.push(i64::try_from(limit).unwrap_or(i64::MAX).into());
        let mut statement = self
            .reader
            .connection()?
            .prepare(&sql)
            .map_err(ConversationError::sqlite)?;
        statement
            .query_map(params_from_iter(values), |row| {
                Ok(PublicSessionRow {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    project_id: row.get(2)?,
                    gateway_origin: row.get(3)?,
                    status: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    message_count: row.get(7)?,
                    last_eligible_message_at: row.get(8)?,
                })
            })
            .map_err(ConversationError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ConversationError::sqlite)
    }

    /// Preview messages of a session.
    pub fn preview_messages(
        &self,
        session_id: &str,
        messages: MessageOrigins,
        time: Option<(&str, &str)>,
        limit: usize,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        let mut sql = String::from(
            "SELECT m.id FROM conversation_messages m WHERE m.session_id=? AND m.visibility='model' AND m.status IN ('complete','compacted') AND m.role IN ('user','assistant')",
        );
        let mut values: Vec<Value> = vec![session_id.to_owned().into()];
        if messages == MessageOrigins::PublicOnly {
            sql.push_str(" AND m.origin_kind IN ('user_input','assistant_public')");
        }
        if let Some((from, to)) = time {
            sql.push_str(" AND m.created_at >= ? AND m.created_at < ?");
            values.extend([from.to_owned().into(), to.to_owned().into()]);
        }
        sql.push_str(" ORDER BY m.created_at DESC,m.id DESC LIMIT ?");
        values.push(i64::try_from(limit).unwrap_or(i64::MAX).into());
        let ids = {
            let mut statement = self
                .reader
                .connection()?
                .prepare(&sql)
                .map_err(ConversationError::sqlite)?;
            statement
                .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
                .map_err(ConversationError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(ConversationError::sqlite)?
        };
        let mut messages = ids
            .into_iter()
            .map(|id| self.message(&id))
            .collect::<ConversationResult<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        messages.reverse();
        Ok(messages)
    }

    /// A session's external id for a gateway.
    pub fn external_session_id(
        &self,
        session_id: &str,
        gateway: &str,
    ) -> ConversationResult<Option<String>> {
        use rusqlite::OptionalExtension;
        self.reader.connection()?.query_row(
            "SELECT external_session_id FROM conversation_bindings WHERE conversation_session_id=?1 AND gateway=?2 ORDER BY created_at LIMIT 1",
            params![session_id,gateway], |row| row.get(0),
        ).optional().map_err(ConversationError::sqlite)
    }
}

fn append_in(sql: &mut String, column: &str, ids: &[String], values: &mut Vec<Value>) {
    sql.push_str(" AND ");
    sql.push_str(column);
    sql.push_str(" IN (");
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            sql.push(',');
        }
        sql.push('?');
        values.push(id.clone().into());
    }
    sql.push(')');
}
