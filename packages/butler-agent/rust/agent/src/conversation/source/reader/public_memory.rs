//! Pinned, read-only canonical Conversation view for public memory tools.

use std::path::Path;

mod sessions;
pub(crate) use sessions::PublicSessionRow;

use rusqlite::{OptionalExtension, params_from_iter, types::Value};

use super::ConversationSourceReader;
use crate::conversation::{
    ConversationError, ConversationMessageWithParts, ConversationOriginKind, ConversationResult,
    ConversationRole, ConversationSession, ConversationSummary, ReadAroundInput,
};

#[derive(Clone, Debug)]
pub(crate) struct CanonicalMemoryReadBinding {
    pub(crate) runtime_session_id: String,
    pub(crate) turn_id: String,
    pub(crate) project_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PublicMemoryScope {
    pub(crate) current_session_id: String,
    pub(crate) current_project_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) session_ids: Vec<String>,
    pub(crate) project_filter: String,
    pub(crate) project_ids: Vec<String>,
    pub(crate) include_internal: bool,
}

pub(crate) struct PublicMemorySnapshot {
    reader: ConversationSourceReader,
    turn_id: String,
    pub(crate) current_session_id: String,
}

impl PublicMemorySnapshot {
    pub(crate) fn open(
        path: &Path,
        binding: &CanonicalMemoryReadBinding,
    ) -> ConversationResult<Self> {
        let reader = ConversationSourceReader::open(path)?;
        reader
            .connection()?
            .execute_batch("BEGIN")
            .map_err(ConversationError::sqlite)?;
        let turn = reader.read_turn(&binding.turn_id)?;
        let session = turn
            .as_ref()
            .map(|turn| reader.read_session(&turn.session_id))
            .transpose()?
            .flatten();
        let runtime_project = binding
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let valid = session.as_ref().is_some_and(|session| {
            session.status == "active"
                && session.project_id.as_deref() == runtime_project
                && !session.gateway_origin.trim().is_empty()
        });
        if !valid {
            return Err(ConversationError::new(
                "invalid_scope",
                "Canonical Turn binding is invalid",
            ));
        }
        let session = session.expect("checked above");
        let external: Option<String> = reader.connection()?.query_row(
            "SELECT external_session_id FROM conversation_bindings WHERE conversation_session_id=?1 AND gateway=?2 ORDER BY created_at LIMIT 1",
            [&session.id, &session.gateway_origin], |row| row.get(0),
        ).optional().map_err(ConversationError::sqlite)?;
        if external.as_deref() != Some(binding.runtime_session_id.trim()) {
            return Err(ConversationError::new(
                "invalid_scope",
                "Runtime session binding is invalid",
            ));
        }
        Ok(Self {
            reader,
            turn_id: binding.turn_id.clone(),
            current_session_id: session.id,
        })
    }

    /// Resolve the source-preferred request message and ensure it is public
    /// user input for this exact canonical Turn and session.
    pub(crate) fn authored_user_message_id(&self) -> ConversationResult<Option<String>> {
        let from_outcome = self
            .reader
            .read_turn_outcome(&self.turn_id)?
            .and_then(|outcome| outcome.request_message_id)
            .filter(|id| !id.is_empty());
        let current_request = if from_outcome.is_none() {
            let mut statement = self
                .reader
                .connection()?
                .prepare(
                    "SELECT id FROM conversation_messages WHERE turn_id=?1 AND role='user' \
                 AND origin_kind='user_input' ORDER BY seq,id LIMIT 2",
                )
                .map_err(ConversationError::sqlite)?;
            let matches = statement
                .query_map([&self.turn_id], |row| row.get::<_, String>(0))
                .map_err(ConversationError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(ConversationError::sqlite)?;
            (matches.len() == 1).then(|| matches[0].clone())
        } else {
            None
        };
        let Some(message_id) = from_outcome.or(current_request) else {
            return Ok(None);
        };
        let Some(message) = self.reader.read_message(&message_id)? else {
            return Ok(None);
        };
        let message = message.message;
        Ok((message.role == ConversationRole::User
            && message.session_id == self.current_session_id
            && message.turn_id.as_deref() == Some(self.turn_id.as_str())
            && message.origin_kind == ConversationOriginKind::UserInput)
            .then_some(message.id))
    }

    pub(crate) fn close(self) -> ConversationResult<()> {
        self.reader.close()
    }

    pub(crate) fn revision(&self) -> ConversationResult<u64> {
        self.reader
            .connection()?
            .query_row(
                "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.unwrap_or(0))
            .map_err(ConversationError::sqlite)
    }

    pub(crate) fn session(&self, id: &str) -> ConversationResult<Option<ConversationSession>> {
        self.reader.read_session(id)
    }

    pub(crate) fn message(
        &self,
        id: &str,
    ) -> ConversationResult<Option<ConversationMessageWithParts>> {
        self.reader.read_message(id)
    }

    pub(crate) fn context_rows(
        &self,
        session_id: &str,
        anchor: Option<&str>,
        direction: &str,
        limit: usize,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        crate::conversation::messages::around(
            self.reader.connection()?,
            ReadAroundInput {
                session_id: session_id.to_owned(),
                anchor_message_id: anchor.map(str::to_owned),
                direction: Some(direction.to_owned()),
                limit: Some(limit as f64),
                include_compacted: false,
            },
        )
    }

    pub(crate) fn summaries(
        &self,
        session_id: &str,
    ) -> ConversationResult<Vec<ConversationSummary>> {
        let summaries =
            crate::conversation::summaries::query_summaries(self.reader.connection()?, session_id)?;
        for summary in &summaries {
            let actual = crate::conversation::summaries::range_hash(
                self.reader.connection()?,
                session_id,
                summary.covers_from_seq,
                summary.covers_to_seq,
            )?;
            if actual != summary.source_hash {
                return Err(ConversationError::new(
                    "conversation_stale_summary_requires_writer",
                    "Stale summary requires canonical writer reconciliation",
                ));
            }
        }
        Ok(summaries)
    }

    pub(crate) fn validate_scope(&self, scope: &PublicMemoryScope) -> ConversationResult<bool> {
        let Some(current) = self.session(&scope.current_session_id)? else {
            return Ok(false);
        };
        if current.status == "deleted"
            || current.project_id != scope.current_project_id
            || scope.current_session_id != self.current_session_id
            || scope.kind == "current_project" && scope.current_project_id.is_none()
        {
            return Ok(false);
        }
        for id in &scope.session_ids {
            let Some(row) = self.session(id)? else {
                return Ok(false);
            };
            if row.status == "deleted"
                || scope.kind == "current_session" && row.id != current.id
                || scope.kind == "current_project" && row.project_id != scope.current_project_id
            {
                return Ok(false);
            }
        }
        for project in &scope.project_ids {
            if scope.kind != "all_user_sessions"
                && Some(project) != scope.current_project_id.as_ref()
            {
                return Ok(false);
            }
            let found: bool = self.reader.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM conversation_sessions WHERE project_id=?1 AND status!='deleted')",
                [project], |row| row.get(0),
            ).map_err(ConversationError::sqlite)?;
            if !found {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(crate) fn permits(
        &self,
        scope: &PublicMemoryScope,
        session_id: &str,
        project_id: Option<&str>,
    ) -> bool {
        let base = match scope.kind.as_str() {
            "current_session" => session_id == scope.current_session_id,
            "current_project" => project_id == scope.current_project_id.as_deref(),
            "all_user_sessions" => true,
            _ => false,
        };
        base && (scope.session_ids.is_empty()
            || scope.session_ids.iter().any(|id| id == session_id))
            && match scope.project_filter.as_str() {
                "any" => true,
                "unassigned" => project_id.is_none(),
                "selected" => project_id
                    .is_some_and(|id| scope.project_ids.iter().any(|project| project == id)),
                _ => false,
            }
    }

    pub(crate) fn message_page(
        &self,
        scope: &PublicMemoryScope,
        role: Option<&str>,
        time: Option<(&str, &str)>,
        latest: bool,
        after: Option<(&str, &str)>,
        limit: usize,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        let mut sql = String::from(
            "SELECT m.id FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE m.visibility='model' AND m.status IN ('complete','compacted') AND m.role IN ('user','assistant') AND s.status!='deleted'",
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
            sql.push_str(" AND m.session_id IN (");
            placeholders(&mut sql, scope.session_ids.len());
            sql.push(')');
            values.extend(scope.session_ids.iter().cloned().map(Value::from));
        }
        if scope.project_filter == "unassigned" {
            sql.push_str(" AND s.project_id IS NULL");
        }
        if scope.project_filter == "selected" {
            sql.push_str(" AND s.project_id IN (");
            placeholders(&mut sql, scope.project_ids.len());
            sql.push(')');
            values.extend(scope.project_ids.iter().cloned().map(Value::from));
        }
        if let Some(role) = role {
            sql.push_str(" AND m.role=?");
            values.push(role.to_owned().into());
        }
        if let Some((from, to)) = time {
            sql.push_str(" AND m.created_at>=? AND m.created_at<?");
            values.push(from.to_owned().into());
            values.push(to.to_owned().into());
        }
        if let Some((at, id)) = after {
            sql.push_str(if latest {
                " AND (m.created_at<? OR (m.created_at=? AND m.id<?))"
            } else {
                " AND (m.created_at>? OR (m.created_at=? AND m.id>?))"
            });
            values.extend([
                at.to_owned().into(),
                at.to_owned().into(),
                id.to_owned().into(),
            ]);
        }
        sql.push_str(if latest {
            " ORDER BY m.created_at DESC,m.id DESC LIMIT ?"
        } else {
            " ORDER BY m.created_at ASC,m.id ASC LIMIT ?"
        });
        values.push((limit as i64).into());
        let mut statement = self
            .reader
            .connection()?
            .prepare(&sql)
            .map_err(ConversationError::sqlite)?;
        let ids = statement
            .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
            .map_err(ConversationError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(ConversationError::sqlite)?;
        ids.iter()
            .map(|id| self.reader.read_message(id))
            .collect::<ConversationResult<Vec<_>>>()
            .map(|rows| rows.into_iter().flatten().collect())
    }
}

fn placeholders(sql: &mut String, count: usize) {
    for index in 0..count {
        if index > 0 {
            sql.push(',');
        }
        sql.push('?');
    }
}
