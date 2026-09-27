//! Pinned, read-only canonical Conversation view for public memory tools.

use std::path::Path;

mod sessions;
pub use sessions::{Archived, MessageOrigins, PublicSessionRow};

use rusqlite::{OptionalExtension, params_from_iter, types::Value};

use super::ConversationSourceReader;
use crate::conversation::ConversationCode;
use crate::conversation::{
    ConversationError, ConversationMessageWithParts, ConversationOriginKind, ConversationResult,
    ConversationRole, ConversationSession, ConversationSummary, ReadAroundInput,
};

/// The runtime session and turn a memory read is made for.
#[derive(Clone, Debug)]
pub struct CanonicalMemoryReadBinding {
    pub runtime_session_id: String,
    pub turn_id: String,
    pub project_id: Option<String>,
}

/// Which sessions a public memory read may see.
#[derive(Clone, Debug)]
pub struct PublicMemoryScope {
    pub current_session_id: String,
    pub current_project_id: Option<String>,
    pub kind: String,
    pub session_ids: Vec<String>,
    pub project_filter: String,
    pub project_ids: Vec<String>,
    pub include_internal: bool,
}

/// Whether a message page starts from the oldest or the latest message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageOrder {
    Oldest,
    Latest,
}

/// A consistent read transaction over public conversation memory.
pub struct PublicMemorySnapshot {
    reader: ConversationSourceReader,
    turn_id: String,
    pub current_session_id: String,
}

impl PublicMemorySnapshot {
    /// Opens a read snapshot for the binding.
    pub fn open(path: &Path, binding: &CanonicalMemoryReadBinding) -> ConversationResult<Self> {
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
                ConversationCode::InvalidScope,
                "Canonical Turn binding is invalid",
            ));
        }
        let Some(session) = session else {
            return Err(ConversationError::new(
                ConversationCode::InvalidScope,
                "Canonical Turn binding is invalid",
            ));
        };
        let external: Option<String> = reader.connection()?.query_row(
            "SELECT external_session_id FROM conversation_bindings WHERE conversation_session_id=?1 AND gateway=?2 ORDER BY created_at LIMIT 1",
            [&session.id, &session.gateway_origin], |row| row.get(0),
        ).optional().map_err(ConversationError::sqlite)?;
        if external.as_deref() != Some(binding.runtime_session_id.trim()) {
            return Err(ConversationError::new(
                ConversationCode::InvalidScope,
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
    pub fn authored_user_message_id(&self) -> ConversationResult<Option<String>> {
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
            match matches.as_slice() {
                [only] => Some(only.clone()),
                _ => None,
            }
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

    /// Ends the snapshot.
    pub fn close(self) -> ConversationResult<()> {
        self.reader.close()
    }

    /// The public source revision the snapshot reads at.
    pub fn revision(&self) -> ConversationResult<u64> {
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

    /// A session by id.
    pub fn session(&self, id: &str) -> ConversationResult<Option<ConversationSession>> {
        self.reader.read_session(id)
    }

    /// A message by id.
    pub fn message(&self, id: &str) -> ConversationResult<Option<ConversationMessageWithParts>> {
        self.reader.read_message(id)
    }

    /// Messages around an anchor in a direction.
    pub fn context_rows(
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
                direction: Some(crate::conversation::AroundDirection::parse(direction)),
                limit: Some(limit as f64),
                include_compacted: false,
            },
        )
    }

    /// A session's summaries whose covered range still hashes as stored.
    pub fn summaries(&self, session_id: &str) -> ConversationResult<Vec<ConversationSummary>> {
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
                    ConversationCode::ConversationStaleSummaryRequiresWriter,
                    "Stale summary requires canonical writer reconciliation",
                ));
            }
        }
        Ok(summaries)
    }

    /// Whether the scope's current session and project still permit the read.
    pub fn validate_scope(&self, scope: &PublicMemoryScope) -> ConversationResult<bool> {
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

    /// Whether the scope may read a session of a project.
    pub fn permits(
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

    /// A page of public messages in scope.
    pub fn message_page(
        &self,
        scope: &PublicMemoryScope,
        role: Option<&str>,
        time: Option<(&str, &str)>,
        order: PageOrder,
        after: Option<(&str, &str)>,
        limit: usize,
    ) -> ConversationResult<Vec<ConversationMessageWithParts>> {
        let mut sql = String::from(
            "SELECT m.id FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE m.visibility='model' AND m.status IN ('complete','compacted') AND m.role IN ('user','assistant') AND s.status!='deleted'",
        );
        let mut values: Vec<Value> = Vec::new();
        scope_filter(&mut sql, &mut values, scope);
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
            sql.push_str(if order == PageOrder::Latest {
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
        sql.push_str(if order == PageOrder::Latest {
            " ORDER BY m.created_at DESC,m.id DESC LIMIT ?"
        } else {
            " ORDER BY m.created_at ASC,m.id ASC LIMIT ?"
        });
        values.push(i64::try_from(limit).unwrap_or(i64::MAX).into());
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

/// Restricts a message page to the scope's sessions and projects.
// Passthrough: SQL parameter values.
fn scope_filter(sql: &mut String, values: &mut Vec<Value>, scope: &PublicMemoryScope) {
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
        placeholders(sql, scope.session_ids.len());
        sql.push(')');
        values.extend(scope.session_ids.iter().cloned().map(Value::from));
    }
    if scope.project_filter == "unassigned" {
        sql.push_str(" AND s.project_id IS NULL");
    }
    if scope.project_filter == "selected" {
        sql.push_str(" AND s.project_id IN (");
        placeholders(sql, scope.project_ids.len());
        sql.push(')');
        values.extend(scope.project_ids.iter().cloned().map(Value::from));
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
